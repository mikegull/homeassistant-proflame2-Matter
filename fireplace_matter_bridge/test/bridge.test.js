// End-to-end test: fake Home Assistant <-> bridge <-> Matter endpoints (Matter commands invoked locally,
// exactly as the cluster servers would run them for a HomeKit request).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Endpoint, Environment, Network, ServerNode, VendorId } from "@matter/main";
import { FanControl } from "@matter/main/clusters/fan-control";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { buildAccessories } from "../src/build.js";
import { discoverFireplaces } from "../src/discovery.js";
import { HomeAssistantClient } from "../src/ha-client.js";
import { MockHomeAssistant } from "./mock-ha.js";

/**
 * Matter needs IPv6. Sandboxed CI containers often have none, so give matter.js inert IPv6 sockets there;
 * the tests drive the Matter clusters locally and do not need real networking.
 */
function stubIpv6IfMissing() {
    const network = Environment.default.get(Network);
    const create = network.createUdpSocket.bind(network);
    network.createUdpSocket = async options => {
        try {
            return await create(options);
        } catch (err) {
            if (options.type !== "udp6" && options.type !== "udp") throw err;
            return {
                maxPayloadSize: 1232,
                addMembership() {},
                dropMembership() {},
                onData: () => ({ close: async () => {} }),
                send: async () => {},
                close: async () => {},
                port: options.listeningPort ?? 0,
                supports: () => false,
            };
        }
    };
}

const quiet = { info() {}, warn: m => console.warn(m), error: m => console.error(m) };
const wait = ms => new Promise(r => setTimeout(r, ms));
const DEBOUNCE = 50;

let mock, ha, server, storage;
const acc = {};

before(async () => {
    mock = await new MockHomeAssistant().start();
    ha = new HomeAssistantClient({ url: mock.url, token: "test-token", logger: quiet });
    await ha.connect();
    const ctx = { ha, log: quiet, unit: "°F", serialPrefix: "T", accessories: [] };
    const fireplaces = await discoverFireplaces(ha, { fireplaces: [{ debounce_ms: DEBOUNCE }] }, quiet);

    storage = mkdtempSync(join(tmpdir(), "fmb-test-"));
    Environment.default.vars.set("storage.path", storage);
    stubIpv6IfMissing();
    server = await ServerNode.create({
        id: "test-bridge",
        network: { port: 0 },
        productDescription: { name: "Test", deviceType: AggregatorEndpoint.deviceType },
        basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000, vendorName: "t", productName: "t" },
    });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: "fireplaces" });
    await server.add(aggregator);
    for (const fp of fireplaces) {
        for (const a of buildAccessories(ctx, fp)) {
            ctx.accessories.push(a);
            await a.create(aggregator);
            acc[a.name] = a;
        }
    }
    ha.on("state_changed", id => ctx.accessories.filter(a => a.entityIds.includes(id)).forEach(a => a.refresh()));
});

after(async () => {
    if (process.env.SHOW_CALLS) console.log("CALLS", JSON.stringify(mock.calls, null, 0));
    await server?.close();
    ha?.close();
    await mock?.stop();
    rmSync(storage, { recursive: true, force: true });
});

/** Waits for the debounced flush and the follow-up re-sync. */
const settle = () => wait(DEBOUNCE + 2800);
const callsFor = entity => mock.calls.filter(c => c.entity_id === entity);

test("exposes every fireplace option as a Matter endpoint", () => {
    assert.deepEqual(Object.keys(acc).sort(), [
        "Den Fireplace",
        "Den Fireplace Aux",
        "Den Fireplace Blower",
        "Den Fireplace Eco Mode",
        "Den Fireplace Front Burner",
        "Den Fireplace LED Strip",
        "Den Fireplace Light",
        "Den Fireplace Manual Mode",
        "Den Fireplace Pilot",
        "Den Fireplace Room Temp",
        "Den Fireplace Smart Mode",
        "Den Fireplace Thermostat",
        "Den Fireplace Timer 1h",
        "Den Fireplace Timer 2h",
        "Den Fireplace Timer 30 min",
        "Den Fireplace Timer 4h",
        "Great Room Fireplace",
        "Great Room Fireplace Aux",
        "Great Room Fireplace Blower",
        "Great Room Fireplace Light",
        "Great Room Fireplace Pilot",
        "Great Room Front Burner", // shortened: Matter labels are max. 32 characters
    ]);
});

test("flame: turning on and dimming sets power and flame height", async () => {
    const flame = acc["Great Room Fireplace"].endpoint;
    assert.equal(flame.state.onOff.onOff, false);
    await flame.act(agent => agent.levelControl.moveToLevelWithOnOff({ level: 212, transitionTime: 0, optionsMask: {}, optionsOverride: {} }));
    await settle();
    assert.equal(mock.states.get("switch.great_room_fireplace_power").state, "on");
    assert.equal(mock.states.get("number.great_room_fireplace_flame").state, "5");
    assert.equal(flame.state.onOff.onOff, true);

    await flame.act(agent => agent.onOff.off());
    await settle();
    assert.equal(mock.states.get("switch.great_room_fireplace_power").state, "off");
});

test("flame: changes made in Home Assistant show up in Matter", async () => {
    const flame = acc["Great Room Fireplace"].endpoint;
    mock.set("switch.great_room_fireplace_power", "on");
    mock.set("number.great_room_fireplace_flame", 2);
    await wait(200);
    assert.equal(flame.state.onOff.onOff, true);
    assert.equal(flame.state.levelControl.currentLevel, 85);
    assert.equal(callsFor("number.great_room_fireplace_flame").length, 1, "no echo service calls");
});

test("blower: percent and fan mode map to 0..6 levels", async () => {
    const fan = acc["Great Room Fireplace Blower"].endpoint;
    await fan.set({ fanControl: { percentSetting: 50 } });
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_fan").state, "3");
    assert.equal(fan.state.fanControl.fanMode, FanControl.FanMode.Medium);

    await fan.set({ fanControl: { fanMode: FanControl.FanMode.High } });
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_fan").state, "6");

    await fan.set({ fanControl: { fanMode: FanControl.FanMode.Off } });
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_fan").state, "0");
});

test("accent light number: brightness maps to 1..6, off to 0", async () => {
    const light = acc["Great Room Fireplace Light"].endpoint;
    await light.act(agent => agent.onOff.on());
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_light").state, "6");
    await light.act(agent => agent.levelControl.moveToLevel({ level: 42, transitionTime: 0, optionsMask: {}, optionsOverride: {} }));
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_light").state, "1");
    await light.act(agent => agent.onOff.off());
    await settle();
    assert.equal(mock.states.get("number.great_room_fireplace_light").state, "0");
});

test("switches: front burner, aux, pilot", async () => {
    for (const [name, entity] of [
        ["Great Room Front Burner", "switch.great_room_fireplace_front_burner"],
        ["Great Room Fireplace Aux", "switch.great_room_fireplace_aux"],
        ["Great Room Fireplace Pilot", "switch.great_room_fireplace_cpi"],
    ]) {
        await acc[name].endpoint.act(agent => agent.onOff.on());
        await settle();
        assert.equal(mock.states.get(entity).state, "on", name);
    }
    mock.set("switch.great_room_fireplace_aux", "off");
    await wait(200);
    assert.equal(acc["Great Room Fireplace Aux"].endpoint.state.onOff.onOff, false);
});

test("thermostat: heat mode and setpoint in °F", async () => {
    const t = acc["Den Fireplace Thermostat"].endpoint;
    assert.equal(t.state.thermostat.localTemperature, 1889); // 66 °F
    await t.set({ thermostat: { systemMode: Thermostat.SystemMode.Heat, occupiedHeatingSetpoint: 2222 } }); // 72 °F
    await settle();
    const climate = mock.states.get("climate.den_fireplace_thermostat");
    assert.equal(climate.state, "heat");
    assert.equal(climate.attributes.temperature, 72);

    mock.set("climate.den_fireplace_thermostat", null, { current_temperature: 68, hvac_action: "heating" });
    await wait(200);
    assert.equal(t.state.thermostat.localTemperature, 2000);
    assert.equal(t.state.thermostat.thermostatRunningState.heat, true);
});

test("thermostat presets act like radio buttons", async () => {
    await acc["Den Fireplace Eco Mode"].endpoint.act(agent => agent.onOff.on());
    await settle();
    assert.equal(mock.states.get("climate.den_fireplace_thermostat").attributes.preset_mode, "eco");
    assert.equal(acc["Den Fireplace Smart Mode"].endpoint.state.onOff.onOff, false);
    assert.equal(acc["Den Fireplace Manual Mode"].endpoint.state.onOff.onOff, false);

    await acc["Den Fireplace Eco Mode"].endpoint.act(agent => agent.onOff.off());
    await settle();
    assert.equal(mock.states.get("climate.den_fireplace_thermostat").state, "off");
});

test("auto-off timer presets", async () => {
    await acc["Den Fireplace Timer 2h"].endpoint.act(agent => agent.onOff.on());
    await settle();
    assert.equal(mock.states.get("number.den_fireplace_auto_off_timer").state, "120");
    // Counting down keeps the 2h switch on
    mock.set("number.den_fireplace_auto_off_timer", 100);
    await wait(200);
    assert.equal(acc["Den Fireplace Timer 2h"].endpoint.state.onOff.onOff, true);
    assert.equal(acc["Den Fireplace Timer 1h"].endpoint.state.onOff.onOff, false);

    await acc["Den Fireplace Timer 30 min"].endpoint.act(agent => agent.onOff.on());
    await settle();
    assert.equal(mock.states.get("number.den_fireplace_auto_off_timer").state, "30");
    assert.equal(acc["Den Fireplace Timer 2h"].endpoint.state.onOff.onOff, false);
});

test("HA light entity with color (LED strip)", async () => {
    const led = acc["Den Fireplace LED Strip"].endpoint;
    await led.act(agent => agent.onOff.on());
    await led.act(agent =>
        agent.colorControl.moveToHueAndSaturation({ hue: 127, saturation: 254, transitionTime: 0, optionsMask: {}, optionsOverride: {} }),
    );
    await settle();
    const s = mock.states.get("light.den_fireplace_led_strip");
    assert.equal(s.state, "on");
    assert.deepEqual(s.attributes.hs_color, [180, 100]);
});

test("unavailable entities mark the accessory unreachable", async () => {
    mock.set("switch.den_fireplace_auxiliary_output", "unavailable");
    await wait(200);
    assert.equal(acc["Den Fireplace Aux"].endpoint.state.bridgedDeviceBasicInformation.reachable, false);
    mock.set("switch.den_fireplace_auxiliary_output", "off");
    await wait(200);
    assert.equal(acc["Den Fireplace Aux"].endpoint.state.bridgedDeviceBasicInformation.reachable, true);
});
