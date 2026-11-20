// A tiny fake Home Assistant WebSocket API with two Proflame fireplaces, used by the tests.

import { WebSocketServer } from "ws";

const st = (entity_id, state, attributes = {}) => ({ entity_id, state: String(state), attributes, last_changed: "" });

export function fixtureStates() {
    return [
        // jeffgregx2/HACS-Proflame2 (domain proflame2)
        st("switch.great_room_fireplace_power", "off", { friendly_name: "Great Room Fireplace Power" }),
        st("number.great_room_fireplace_flame", 3, { friendly_name: "Great Room Fireplace Flame", min: 1, max: 6, step: 1 }),
        st("number.great_room_fireplace_fan", 0, { friendly_name: "Great Room Fireplace Fan", min: 0, max: 6, step: 1 }),
        st("number.great_room_fireplace_light", 0, { friendly_name: "Great Room Fireplace Light", min: 0, max: 6, step: 1 }),
        st("switch.great_room_fireplace_front_burner", "off", { friendly_name: "Great Room Fireplace Front Burner" }),
        st("switch.great_room_fireplace_aux", "off", { friendly_name: "Great Room Fireplace Aux" }),
        st("switch.great_room_fireplace_cpi", "off", { friendly_name: "Great Room Fireplace CPI" }),
        st("switch.great_room_fireplace_pcm_payload_logging", "off", { friendly_name: "Great Room Fireplace PCM Payload Logging" }),
        st("sensor.great_room_fireplace", "Off", { friendly_name: "Great Room Fireplace" }),

        // psaab/proflame_wifi (domain proflame_wifi)
        st("climate.den_fireplace_thermostat", "off", {
            friendly_name: "Den Fireplace Thermostat",
            hvac_modes: ["off", "heat"],
            preset_modes: ["smart", "eco", "manual"],
            preset_mode: "manual",
            min_temp: 50,
            max_temp: 90,
            target_temp_step: 1,
            temperature: 70,
            current_temperature: 66,
            hvac_action: "off",
        }),
        st("switch.den_fireplace_power", "off", { friendly_name: "Den Fireplace Power" }),
        st("number.den_fireplace_flame_level", 6, { friendly_name: "Den Fireplace Flame Level", min: 0, max: 6, step: 1 }),
        st("number.den_fireplace_fan_level", 0, { friendly_name: "Den Fireplace Fan Level", min: 0, max: 6, step: 1 }),
        st("number.den_fireplace_auto_off_timer", 0, { friendly_name: "Den Fireplace Auto-Off Timer", min: 0, max: 360, step: 1 }),
        st("switch.den_fireplace_continuous_pilot", "off", { friendly_name: "Den Fireplace Continuous Pilot" }),
        st("switch.den_fireplace_auxiliary_output", "off", { friendly_name: "Den Fireplace Auxiliary Output" }),
        st("switch.den_fireplace_front_flame_split_flow", "off", { friendly_name: "Den Fireplace Front Flame / Split Flow" }),
        st("switch.den_fireplace_thermostat_mode", "off", { friendly_name: "Den Fireplace Thermostat Mode" }),
        st("light.den_fireplace_accent_light", "off", {
            friendly_name: "Den Fireplace Accent Light",
            supported_color_modes: ["brightness"],
            color_mode: null,
            brightness: null,
        }),
        st("light.den_fireplace_led_strip", "off", {
            friendly_name: "Den Fireplace LED Strip",
            supported_color_modes: ["rgb"],
            color_mode: null,
            brightness: null,
            hs_color: null,
        }),
        st("sensor.den_fireplace_room_temperature", 66, {
            friendly_name: "Den Fireplace Room Temperature",
            device_class: "temperature",
            unit_of_measurement: "°F",
        }),
        st("sensor.den_fireplace_wifi_signal", -50, { friendly_name: "Den Fireplace WiFi Signal" }),
    ];
}

const reg = (entity_id, platform, device_id, original_name, extra = {}) => ({
    entity_id,
    platform,
    device_id,
    original_name,
    disabled_by: null,
    hidden_by: null,
    entity_category: null,
    name: null,
    ...extra,
});

export function fixtureRegistry() {
    const p2 = (id, name, extra) => reg(id, "proflame2", "dev_p2", name, extra);
    const pw = (id, name, extra) => reg(id, "proflame_wifi", "dev_pw", name, extra);
    return {
        devices: [
            { id: "dev_p2", name: "Great Room Fireplace", name_by_user: null },
            { id: "dev_pw", name: "Den Fireplace", name_by_user: null },
        ],
        entities: [
            p2("switch.great_room_fireplace_power", "Power"),
            p2("number.great_room_fireplace_flame", "Flame"),
            p2("number.great_room_fireplace_fan", "Fan"),
            p2("number.great_room_fireplace_light", "Light"),
            p2("switch.great_room_fireplace_front_burner", "Front Burner"),
            p2("switch.great_room_fireplace_aux", "Aux"),
            p2("switch.great_room_fireplace_cpi", "CPI"),
            p2("switch.great_room_fireplace_pcm_payload_logging", "PCM Payload Logging", { entity_category: "diagnostic" }),
            p2("sensor.great_room_fireplace", null),
            pw("climate.den_fireplace_thermostat", "Thermostat"),
            pw("switch.den_fireplace_power", "Power"),
            pw("number.den_fireplace_flame_level", "Flame Level"),
            pw("number.den_fireplace_fan_level", "Fan Level"),
            pw("number.den_fireplace_auto_off_timer", "Auto-Off Timer"),
            pw("switch.den_fireplace_continuous_pilot", "Continuous Pilot"),
            pw("switch.den_fireplace_auxiliary_output", "Auxiliary Output"),
            pw("switch.den_fireplace_front_flame_split_flow", "Front Flame / Split Flow"),
            pw("switch.den_fireplace_thermostat_mode", "Thermostat Mode"),
            pw("light.den_fireplace_accent_light", "Accent Light"),
            pw("light.den_fireplace_led_strip", "LED Strip"),
            pw("sensor.den_fireplace_room_temperature", "Room Temperature", { original_device_class: "temperature" }),
            pw("sensor.den_fireplace_wifi_signal", "WiFi Signal"),
        ],
    };
}

export class MockHomeAssistant {
    calls = [];
    states = new Map(fixtureStates().map(s => [s.entity_id, s]));
    registry = fixtureRegistry();
    #clients = new Set();

    async start() {
        this.wss = new WebSocketServer({ port: 0 });
        await new Promise(r => this.wss.on("listening", r));
        this.url = `ws://127.0.0.1:${this.wss.address().port}/api/websocket`;
        this.wss.on("connection", ws => this.#onConnection(ws));
        return this;
    }

    stop() {
        for (const ws of this.#clients) ws.terminate();
        return new Promise(r => this.wss.close(r));
    }

    #onConnection(ws) {
        const send = m => ws.send(JSON.stringify(m));
        send({ type: "auth_required" });
        let authed = false;
        ws.on("message", raw => {
            const msg = JSON.parse(raw.toString());
            if (!authed) {
                if (msg.type === "auth" && msg.access_token === "test-token") {
                    authed = true;
                    this.#clients.add(ws);
                    send({ type: "auth_ok" });
                } else send({ type: "auth_invalid", message: "bad token" });
                return;
            }
            const ok = result => send({ id: msg.id, type: "result", success: true, result });
            switch (msg.type) {
                case "subscribe_events":
                    return ok(null);
                case "get_states":
                    return ok([...this.states.values()]);
                case "get_config":
                    return ok({ unit_system: { temperature: "°F" } });
                case "config/entity_registry/list":
                    return ok(this.registry.entities);
                case "config/device_registry/list":
                    return ok(this.registry.devices);
                case "call_service":
                    this.calls.push({ service: `${msg.domain}.${msg.service}`, entity_id: msg.target?.entity_id, data: msg.service_data });
                    this.#apply(msg.domain, msg.service, msg.target?.entity_id, msg.service_data ?? {});
                    return ok({ context: {} });
                default:
                    send({ id: msg.id, type: "result", success: false, error: { message: "unknown command" } });
            }
        });
        ws.on("close", () => this.#clients.delete(ws));
    }

    /** Change an entity (as the integration would) and broadcast state_changed. */
    set(entityId, state, attributes = {}) {
        const old = this.states.get(entityId);
        const next = { ...old, state: String(state ?? old.state), attributes: { ...old.attributes, ...attributes } };
        this.states.set(entityId, next);
        const event = { type: "event", event: { event_type: "state_changed", data: { entity_id: entityId, old_state: old, new_state: next } } };
        for (const ws of this.#clients) ws.send(JSON.stringify({ id: 1, ...event }));
    }

    #apply(domain, service, entityId, data) {
        const s = this.states.get(entityId);
        if (!s) return;
        if (domain === "switch") this.set(entityId, service === "turn_on" ? "on" : "off");
        if (domain === "number") this.set(entityId, data.value);
        if (domain === "light") {
            if (service === "turn_off") this.set(entityId, "off");
            else this.set(entityId, "on", { brightness: data.brightness ?? s.attributes.brightness ?? 255, ...(data.hs_color ? { hs_color: data.hs_color, color_mode: "hs" } : {}) });
        }
        if (domain === "climate") {
            if (service === "set_hvac_mode") this.set(entityId, data.hvac_mode);
            if (service === "set_temperature") this.set(entityId, null, { temperature: data.temperature });
            if (service === "set_preset_mode") this.set(entityId, "heat", { preset_mode: data.preset_mode });
        }
    }
}
