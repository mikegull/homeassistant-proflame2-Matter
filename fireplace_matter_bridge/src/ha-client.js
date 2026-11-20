// Minimal Home Assistant WebSocket API client with auto-reconnect.
// Uses the WebSocket implementation built into Node.js 22+.

import { EventEmitter } from "node:events";

export class HomeAssistantClient extends EventEmitter {
    #url;
    #token;
    #ws = null;
    #nextId = 1;
    #pending = new Map();
    #states = new Map();
    #connected = false;
    #closing = false;
    #reconnectDelay = 1000;
    #log;

    constructor({ url, token, logger = console }) {
        super();
        this.#url = url;
        this.#token = token;
        this.#log = logger;
    }

    get connected() {
        return this.#connected;
    }

    /** Current state object of an entity (or undefined). */
    state(entityId) {
        return this.#states.get(entityId);
    }

    get states() {
        return this.#states;
    }

    /** Connects and resolves once authenticated and the initial states are loaded. */
    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = err => {
                if (settled) return;
                settled = true;
                err ? reject(err) : resolve();
            };
            this.#open(done);
        });
    }

    #open(onFirstResult) {
        this.#log.info(`Connecting to Home Assistant at ${this.#url}`);
        let ws;
        try {
            ws = new WebSocket(this.#url);
        } catch (err) {
            onFirstResult?.(err);
            return;
        }
        this.#ws = ws;

        ws.addEventListener("message", async event => {
            let msg;
            try {
                msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
            } catch {
                return;
            }
            const messages = Array.isArray(msg) ? msg : [msg];
            for (const m of messages) await this.#handle(m, onFirstResult);
        });

        ws.addEventListener("close", () => {
            const wasConnected = this.#connected;
            this.#connected = false;
            this.#ws = null;
            for (const { reject } of this.#pending.values()) reject(new Error("Connection to Home Assistant closed"));
            this.#pending.clear();
            if (wasConnected && !this.#closing) {
                this.#log.warn("Lost connection to Home Assistant");
                this.emit("disconnected");
            }
            if (this.#closing) return;
            const delay = this.#reconnectDelay;
            this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30_000);
            setTimeout(() => this.#open(onFirstResult), delay);
        });

        ws.addEventListener("error", event => {
            this.#log.warn(`Home Assistant WebSocket error: ${event.message ?? "unknown error"}`);
        });
    }

    async #handle(msg, onFirstResult) {
        switch (msg.type) {
            case "auth_required":
                this.#ws.send(JSON.stringify({ type: "auth", access_token: this.#token }));
                return;
            case "auth_invalid":
                this.#closing = true;
                this.#ws.close();
                onFirstResult?.(new Error(`Home Assistant rejected the access token: ${msg.message}`));
                this.emit("fatal", new Error(`Home Assistant rejected the access token: ${msg.message}`));
                return;
            case "auth_ok":
                try {
                    await this.#onAuthenticated();
                    onFirstResult?.();
                } catch (err) {
                    onFirstResult?.(err);
                }
                return;
            case "result": {
                const p = this.#pending.get(msg.id);
                if (!p) return;
                this.#pending.delete(msg.id);
                msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? "Request failed"));
                return;
            }
            case "event": {
                const ev = msg.event;
                if (ev?.event_type === "state_changed") {
                    const { entity_id, new_state, old_state } = ev.data;
                    if (new_state) this.#states.set(entity_id, new_state);
                    else this.#states.delete(entity_id);
                    this.emit("state_changed", entity_id, new_state, old_state);
                }
                return;
            }
        }
    }

    async #onAuthenticated() {
        this.#reconnectDelay = 1000;
        await this.send({ type: "subscribe_events", event_type: "state_changed" });
        const states = await this.send({ type: "get_states" });
        this.#states = new Map(states.map(s => [s.entity_id, s]));
        this.#connected = true;
        this.#log.info(`Connected to Home Assistant (${states.length} entities)`);
        this.emit("connected");
        this.emit("resync");
    }

    send(payload) {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("Not connected to Home Assistant"));
        }
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#ws.send(JSON.stringify({ id, ...payload }));
        });
    }

    callService(domain, service, entityId, data = {}) {
        this.#log.info(`→ ${domain}.${service} ${entityId ?? ""} ${Object.keys(data).length ? JSON.stringify(data) : ""}`);
        return this.send({
            type: "call_service",
            domain,
            service,
            service_data: data,
            ...(entityId ? { target: { entity_id: entityId } } : {}),
        });
    }

    getConfig() {
        return this.send({ type: "get_config" });
    }

    entityRegistry() {
        return this.send({ type: "config/entity_registry/list" });
    }

    deviceRegistry() {
        return this.send({ type: "config/device_registry/list" });
    }

    close() {
        this.#closing = true;
        this.#ws?.close();
    }
}
