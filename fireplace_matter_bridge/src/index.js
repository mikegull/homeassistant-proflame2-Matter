#!/usr/bin/env node
// Fireplace Matter Bridge: exposes Proflame fireplaces from Home Assistant as Matter devices (for Apple Home).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Endpoint, Environment, Logger, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { QrCode } from "@matter/main/types";
import YAML from "yaml";
import { buildAccessories, describe } from "./build.js";
import { discoverFireplaces } from "./discovery.js";
import { HomeAssistantClient } from "./ha-client.js";

const log = Logger.get("FireplaceBridge");

const { values: args } = parseArgs({
    options: {
        config: { type: "string", short: "c" },
        discover: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
});

if (args.help) {
    console.log(`Usage: fireplace-matter-bridge [--config bridge.yaml] [--discover]

  --config, -c   YAML config file (default: ./bridge.yaml, or the Home Assistant add-on options)
  --discover     Print the fireplaces/entities that would be exposed and exit

Environment overrides: HA_URL, HA_TOKEN, MATTER_PORT, MATTER_PASSCODE, MATTER_DISCRIMINATOR, STORAGE_PATH`);
    process.exit(0);
}

function loadConfig() {
    let config = {};
    const addonOptions = process.env.ADDON_OPTIONS ?? "/data/options.json";
    const file = args.config ?? process.env.CONFIG_FILE ?? (existsSync("bridge.yaml") ? "bridge.yaml" : undefined);
    if (file) {
        config = YAML.parse(readFileSync(resolve(file), "utf8")) ?? {};
    } else if (existsSync(addonOptions)) {
        // Running as a Home Assistant add-on
        const options = JSON.parse(readFileSync(addonOptions, "utf8"));
        const extra = "/config/fireplace-matter-bridge.yaml";
        config = existsSync(extra) ? (YAML.parse(readFileSync(extra, "utf8")) ?? {}) : {};
        config.matter = { ...options, ...config.matter };
        config.fireplaces ??= options.fireplaces;
        config.storage_path ??= "/data/matter";
    }
    config.homeassistant ??= {};
    config.matter ??= {};
    const env = process.env;
    if (env.SUPERVISOR_TOKEN && !config.homeassistant.token) {
        config.homeassistant.url ??= "ws://supervisor/core/websocket";
        config.homeassistant.token = env.SUPERVISOR_TOKEN;
    }
    if (env.HA_URL) config.homeassistant.url = env.HA_URL;
    if (env.HA_TOKEN) config.homeassistant.token = env.HA_TOKEN;
    if (env.MATTER_PORT) config.matter.port = Number(env.MATTER_PORT);
    if (env.MATTER_PASSCODE) config.matter.passcode = Number(env.MATTER_PASSCODE);
    if (env.MATTER_DISCRIMINATOR) config.matter.discriminator = Number(env.MATTER_DISCRIMINATOR);
    if (env.STORAGE_PATH) config.storage_path = env.STORAGE_PATH;

    let url = config.homeassistant.url ?? "ws://homeassistant.local:8123/api/websocket";
    if (/^https?:/.test(url)) url = url.replace(/^http/, "ws");
    if (!/\/websocket$/.test(url)) url = url.replace(/\/$/, "") + "/api/websocket";
    config.homeassistant.url = url;
    if (!config.homeassistant.token) {
        throw new Error("No Home Assistant access token: set homeassistant.token in the config or HA_TOKEN");
    }
    return config;
}

async function main() {
    const config = loadConfig();
    const haLog = {
        info: m => log.info(m),
        warn: m => log.warn(m),
        error: m => log.error(m),
    };
    const ha = new HomeAssistantClient({ ...config.homeassistant, logger: haLog });
    await ha.connect();

    const haConfig = await ha.getConfig().catch(() => ({}));
    const ctx = {
        ha,
        log: haLog,
        unit: haConfig?.unit_system?.temperature ?? "°F",
        serialPrefix: "FMB",
        accessories: [],
    };

    const fireplaces = await discoverFireplaces(ha, config, haLog);
    if (!fireplaces.length || fireplaces.every(fp => !Object.keys(fp.entities).length && !fp.extras.length)) {
        throw new Error(
            "No Proflame fireplace entities found in Home Assistant. Check that the Proflame integration is set up, " +
                "or list the entities explicitly under `fireplaces:` in the config.",
        );
    }

    for (const fp of fireplaces) {
        const accessories = buildAccessories(ctx, fp);
        ctx.accessories.push(...accessories);
        console.log(describe(fp, accessories));
    }

    if (args.discover) {
        ha.close();
        return;
    }

    const m = config.matter;
    if ((m.passcode ?? 20202021) === 20202021) {
        log.warn("Using the well-known default Matter passcode 20202021. Set matter.passcode to your own 8-digit code.");
    }
    if (config.storage_path) Environment.default.vars.set("storage.path", config.storage_path);
    const bridgeName = m.bridge_name ?? "Fireplace Bridge";

    const server = await ServerNode.create({
        id: m.node_id ?? "fireplace-matter-bridge",
        network: { port: m.port ?? 5540 },
        commissioning: { passcode: m.passcode ?? 20202021, discriminator: m.discriminator ?? 3840 },
        productDescription: { name: bridgeName, deviceType: AggregatorEndpoint.deviceType },
        basicInformation: {
            vendorName: "Home Assistant",
            vendorId: VendorId(0xfff1),
            nodeLabel: bridgeName.slice(0, 32),
            productName: "Fireplace Matter Bridge",
            productLabel: "Fireplace Matter Bridge",
            productId: 0x8000,
            serialNumber: m.serial ?? "fireplace-bridge-0001",
            uniqueId: m.node_id ?? "fireplace-matter-bridge",
        },
    });

    const aggregator = new Endpoint(AggregatorEndpoint, { id: "fireplaces" });
    await server.add(aggregator);
    for (const accessory of ctx.accessories) await accessory.create(aggregator);

    // Home Assistant -> Matter
    const byEntity = new Map();
    for (const a of ctx.accessories) {
        for (const id of a.entityIds) {
            if (!byEntity.has(id)) byEntity.set(id, []);
            byEntity.get(id).push(a);
        }
    }
    ha.on("state_changed", entityId => {
        for (const a of byEntity.get(entityId) ?? []) a.refresh().catch(err => log.warn(err.message));
    });
    const refreshAll = () => Promise.all(ctx.accessories.map(a => a.refresh(true))).catch(err => log.warn(err.message));
    ha.on("disconnected", refreshAll);
    ha.on("resync", refreshAll);
    ha.on("fatal", err => {
        log.error(err.message);
        process.exit(1);
    });

    await server.start();

    if (!server.lifecycle.isCommissioned) {
        const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
        console.log("\nPair the bridge in Apple Home: Add Accessory -> scan this code\n");
        console.log(QrCode.get(qrPairingCode));
        console.log(`QR code payload: ${qrPairingCode}`);
        console.log(`Manual pairing code: ${manualPairingCode}\n`);
    } else {
        log.info("Bridge is already paired. To pair with another ecosystem, use 'Turn on pairing mode' in Apple Home.");
    }
}

main().catch(err => {
    console.error(err.stack ?? err);
    process.exit(1);
});
