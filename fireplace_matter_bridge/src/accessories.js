// Matter endpoints that mirror Home Assistant fireplace entities.
//
// Each accessory:
//   * creates one bridged Matter endpoint,
//   * pushes Home Assistant state into Matter (refresh), and
//   * turns changes made from HomeKit/Matter into Home Assistant service calls (flush, debounced).
//
// The Matter endpoint state is the "desired" state while a user change is pending; once the change is sent the
// accessory waits briefly and then re-reads Home Assistant so that both sides converge.

import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { ColorControl } from "@matter/main/clusters/color-control";
import { FanControl } from "@matter/main/clusters/fan-control";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { ExtendedColorLightDevice, ExtendedColorLightRequirements } from "@matter/main/devices/extended-color-light";
import { FanDevice } from "@matter/main/devices/fan";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";
import { ThermostatDevice } from "@matter/main/devices/thermostat";
import {
    brightnessToLevel,
    endpointId,
    haTempToMatter,
    hsToMatter,
    kelvinToMireds,
    label,
    levelToBrightness,
    levelToStep,
    matterTempToHa,
    matterToHs,
    matterToXy,
    miredsToKelvin,
    percentToStep,
    stepToLevel,
    stepToPercent,
    xyToMatter,
} from "./convert.js";

const UNAVAILABLE = new Set(["unavailable", "unknown"]);
const num = v => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

class Accessory {
    endpoint;
    #timer = null;
    #busyUntil = 0;
    #pushing = 0;
    #refreshTimer = null;

    /**
     * @param ctx {{ ha, log, unit, serialPrefix }}
     * @param id unique stable id
     * @param name display name
     * @param entityIds Home Assistant entities this accessory depends on
     */
    constructor(ctx, id, name, entityIds, { debounceMs = 600 } = {}) {
        this.ctx = ctx;
        this.id = endpointId(id);
        this.name = label(name);
        this.entityIds = entityIds.filter(Boolean);
        this.debounceMs = debounceMs;
    }

    get ha() {
        return this.ctx.ha;
    }
    get log() {
        return this.ctx.log;
    }
    st(entityId) {
        return entityId ? this.ha.state(entityId) : undefined;
    }
    value(entityId) {
        return num(this.st(entityId)?.state);
    }
    isOn(entityId) {
        return this.st(entityId)?.state === "on";
    }

    get reachable() {
        return (
            this.ha.connected &&
            this.entityIds.every(id => {
                const s = this.st(id);
                return s && !UNAVAILABLE.has(s.state);
            })
        );
    }

    /** Subclasses: endpoint type and initial cluster state */
    definition() {
        throw new Error("not implemented");
    }

    bridgedInfo() {
        return {
            nodeLabel: this.name,
            productName: label(`Proflame ${this.constructor.kind ?? "Device"}`),
            productLabel: this.name,
            vendorName: "Home Assistant",
            serialNumber: label(`${this.ctx.serialPrefix}-${this.id}`),
            uniqueId: label(this.id),
            reachable: this.reachable,
        };
    }

    async create(aggregator) {
        const { type, state } = this.definition();
        this.endpoint = new Endpoint(type.with(BridgedDeviceBasicInformationServer), {
            id: this.id,
            bridgedDeviceBasicInformation: this.bridgedInfo(),
            ...state,
        });
        await aggregator.add(this.endpoint);
        this.listen();
    }

    /** Subclasses: subscribe to Matter attribute changes; call this.changed() from handlers. */
    listen() {}

    /** Register a handler for a Matter attribute change that ignores our own pushes from HA. */
    on(event, handler) {
        event.on((value, oldValue, context) => {
            if (this.#pushing > 0) return;
            try {
                handler(value, oldValue, context);
            } catch (err) {
                this.log.error(`[${this.name}] ${err.stack ?? err}`);
            }
            this.changed();
        });
    }

    /** A user changed something in Matter: schedule the Home Assistant update. */
    changed() {
        this.#busyUntil = Date.now() + this.debounceMs + 5000;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.#flush(), this.debounceMs);
    }

    async #flush() {
        this.#timer = null;
        try {
            await this.flush();
        } catch (err) {
            this.log.error(`[${this.name}] Home Assistant call failed: ${err.message}`);
        } finally {
            // Give the integration a moment to report the new state, then re-sync from HA.
            this.#busyUntil = Date.now() + 2500;
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = setTimeout(() => this.refresh(), 2600);
        }
    }

    /** Subclasses: send desired Matter state to Home Assistant. */
    async flush() {}

    /** Subclasses: return a partial endpoint state reflecting Home Assistant. */
    fromHa() {
        return {};
    }

    /** Push Home Assistant state into Matter (skipped while a user change is in flight unless forced). */
    async refresh(force = false) {
        if (!this.endpoint) return;
        if (!force && (this.#timer || Date.now() < this.#busyUntil)) return;
        const patch = { bridgedDeviceBasicInformation: { reachable: this.reachable } };
        if (this.reachable) Object.assign(patch, this.fromHa());
        const changes = diff(this.endpoint.state, patch);
        if (!changes) return;
        this.#pushing++;
        try {
            await this.endpoint.set(changes);
        } catch (err) {
            this.log.warn(`[${this.name}] could not apply Home Assistant state ${JSON.stringify(changes)}: ${err.message}`);
        } finally {
            this.#pushing--;
        }
    }

    call(entityId, service, data) {
        const domain = entityId.split(".")[0];
        return this.ha.callService(domain, service, entityId, data);
    }
}

/** Returns only the values of `patch` that differ from `state` (one level of cluster nesting). */
function diff(state, patch) {
    let result;
    for (const [cluster, values] of Object.entries(patch)) {
        for (const [attr, value] of Object.entries(values)) {
            if (value === undefined) continue;
            if (JSON.stringify(state[cluster]?.[attr]) === JSON.stringify(value)) continue;
            result ??= {};
            result[cluster] ??= {};
            result[cluster][attr] = value;
        }
    }
    return result;
}

const levelControlState = (level, extra = {}) => ({
    levelControl: { currentLevel: level, minLevel: 1, maxLevel: 254, onLevel: null, ...extra },
});

// ---------------------------------------------------------------------------------------------------------------
// Fireplace flame: power switch + flame height number -> dimmable light ("on" = fire lit, brightness = flame).
export class FlameAccessory extends Accessory {
    static kind = "Flame";

    constructor(ctx, fp) {
        super(ctx, `${fp.id}-flame`, fp.label, [fp.entities.power, fp.entities.flame], fp.options);
        this.power = fp.entities.power;
        this.flame = fp.entities.flame;
        this.steps = num(this.st(this.flame)?.attributes?.max) ?? fp.options.steps;
    }

    definition() {
        const flame = this.value(this.flame);
        if (!this.flame) return { type: OnOffLightDevice, state: { onOff: { onOff: this.isOn(this.power) } } };
        return {
            type: DimmableLightDevice,
            state: {
                onOff: { onOff: this.isOn(this.power) },
                ...levelControlState(stepToLevel(flame || this.steps, this.steps)),
            },
        };
    }

    listen() {
        this.on(this.endpoint.events.onOff.onOff$Changed, () => {});
        if (this.flame) this.on(this.endpoint.events.levelControl.currentLevel$Changed, () => {});
    }

    fromHa() {
        const patch = { onOff: { onOff: this.isOn(this.power) } };
        const flame = this.value(this.flame);
        if (this.flame && flame >= 1) patch.levelControl = { currentLevel: stepToLevel(flame, this.steps) };
        return patch;
    }

    async flush() {
        const on = this.endpoint.state.onOff.onOff;
        if (!on) {
            if (this.isOn(this.power)) await this.call(this.power, "turn_off");
            return;
        }
        if (!this.isOn(this.power)) await this.call(this.power, "turn_on");
        if (this.flame) {
            const step = levelToStep(this.endpoint.state.levelControl.currentLevel ?? 254, this.steps);
            if (this.value(this.flame) !== step) await this.call(this.flame, "set_value", { value: step });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Number entity (e.g. accent light 0..6) -> dimmable light (0 = off).
export class NumberLightAccessory extends Accessory {
    static kind = "Light";

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
        const attrs = this.st(entityId)?.attributes ?? {};
        this.min = num(attrs.min) ?? 0;
        this.max = num(attrs.max) ?? options.steps ?? 6;
        this.steps = Math.max(1, Math.round((this.max - this.min) / (num(attrs.step) ?? 1)));
        this.stepSize = (this.max - this.min) / this.steps;
        this.lastLevel = 254;
    }

    toStep(v) {
        return Math.round((v - this.min) / this.stepSize);
    }
    fromStep(s) {
        return this.min + s * this.stepSize;
    }

    definition() {
        const v = this.value(this.entity) ?? this.min;
        const step = this.toStep(v);
        return {
            type: DimmableLightDevice,
            state: { onOff: { onOff: step > 0 }, ...levelControlState(stepToLevel(step || this.steps, this.steps)) },
        };
    }

    listen() {
        this.on(this.endpoint.events.onOff.onOff$Changed, () => {});
        this.on(this.endpoint.events.levelControl.currentLevel$Changed, () => {});
    }

    fromHa() {
        const step = this.toStep(this.value(this.entity) ?? this.min);
        const patch = { onOff: { onOff: step > 0 } };
        if (step > 0) patch.levelControl = { currentLevel: stepToLevel(step, this.steps) };
        return patch;
    }

    async flush() {
        const { onOff, levelControl } = this.endpoint.state;
        const target = onOff.onOff ? this.fromStep(levelToStep(levelControl.currentLevel ?? 254, this.steps)) : this.min;
        if (this.value(this.entity) !== target) await this.call(this.entity, "set_value", { value: target });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// HA light entity (accent light, LED strip) -> dimmable or extended color light.
const ColorServer = ExtendedColorLightRequirements.ColorControlServer.with("HueSaturation", "Xy", "ColorTemperature");

export class HaLightAccessory extends Accessory {
    static kind = "Light";
    #colorChange = null;

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
        const modes = this.st(entityId)?.attributes?.supported_color_modes ?? [];
        this.color = modes.some(m => ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(m));
        this.dimmable = this.color || modes.some(m => m !== "onoff");
    }

    #colorState() {
        const a = this.st(this.entity)?.attributes ?? {};
        const state = {};
        if (a.hs_color) {
            const { hue, saturation } = hsToMatter(a.hs_color);
            Object.assign(state, { currentHue: hue, currentSaturation: saturation });
        }
        if (a.xy_color) {
            const { x, y } = xyToMatter(a.xy_color);
            Object.assign(state, { currentX: x, currentY: y });
        }
        if (a.color_mode === "color_temp" && a.color_temp_kelvin) {
            state.colorTemperatureMireds = kelvinToMireds(a.color_temp_kelvin);
            state.colorMode = ColorControl.ColorMode.ColorTemperatureMireds;
            state.enhancedColorMode = ColorControl.EnhancedColorMode.ColorTemperatureMireds;
        } else if (a.hs_color) {
            state.colorMode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
            state.enhancedColorMode = ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation;
        }
        return state;
    }

    definition() {
        const s = this.st(this.entity);
        const on = s?.state === "on";
        const level = brightnessToLevel(num(s?.attributes?.brightness) ?? 255);
        if (!this.dimmable) return { type: OnOffLightDevice, state: { onOff: { onOff: on } } };
        if (!this.color) return { type: DimmableLightDevice, state: { onOff: { onOff: on }, ...levelControlState(level) } };
        return {
            type: ExtendedColorLightDevice.with(ColorServer),
            state: {
                onOff: { onOff: on },
                ...levelControlState(level),
                colorControl: {
                    colorTempPhysicalMinMireds: 153,
                    colorTempPhysicalMaxMireds: 500,
                    coupleColorTempToLevelMinMireds: 153,
                    startUpColorTemperatureMireds: null,
                    colorTemperatureMireds: 370,
                    currentHue: 0,
                    currentSaturation: 0,
                    currentX: 0x616b,
                    currentY: 0x607d,
                    colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                    enhancedColorMode: ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
                    ...this.#colorState(),
                },
            },
        };
    }

    listen() {
        const ev = this.endpoint.events;
        this.on(ev.onOff.onOff$Changed, () => {});
        if (!this.dimmable) return;
        this.on(ev.levelControl.currentLevel$Changed, () => {});
        if (!this.color) return;
        this.on(ev.colorControl.currentHue$Changed, () => (this.#colorChange = "hs"));
        this.on(ev.colorControl.currentSaturation$Changed, () => (this.#colorChange = "hs"));
        this.on(ev.colorControl.currentX$Changed, () => (this.#colorChange = "xy"));
        this.on(ev.colorControl.currentY$Changed, () => (this.#colorChange = "xy"));
        this.on(ev.colorControl.colorTemperatureMireds$Changed, () => (this.#colorChange = "ct"));
    }

    fromHa() {
        const s = this.st(this.entity);
        const patch = { onOff: { onOff: s?.state === "on" } };
        const brightness = num(s?.attributes?.brightness);
        if (this.dimmable && brightness) patch.levelControl = { currentLevel: brightnessToLevel(brightness) };
        if (this.color && s?.state === "on") patch.colorControl = this.#colorState();
        return patch;
    }

    async flush() {
        const { onOff, levelControl, colorControl } = this.endpoint.state;
        const s = this.st(this.entity);
        if (!onOff.onOff) {
            if (s?.state !== "off") await this.call(this.entity, "turn_off");
            this.#colorChange = null;
            return;
        }
        const data = {};
        if (this.dimmable) {
            const brightness = levelToBrightness(levelControl.currentLevel ?? 254);
            if (brightness !== num(s?.attributes?.brightness)) data.brightness = brightness;
        }
        switch (this.#colorChange) {
            case "hs":
                data.hs_color = matterToHs(colorControl.currentHue, colorControl.currentSaturation);
                break;
            case "xy":
                data.xy_color = matterToXy(colorControl.currentX, colorControl.currentY);
                break;
            case "ct":
                data.color_temp_kelvin = miredsToKelvin(colorControl.colorTemperatureMireds);
                break;
        }
        this.#colorChange = null;
        if (s?.state !== "on" || Object.keys(data).length) await this.call(this.entity, "turn_on", data);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Blower: number (0..6) or HA fan entity -> Matter fan.
export class FanAccessory extends Accessory {
    static kind = "Blower";

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
        this.isFanEntity = entityId.startsWith("fan.");
        this.steps = this.isFanEntity
            ? 100
            : Math.round(num(this.st(entityId)?.attributes?.max) ?? options.steps ?? 6);
        this.lastStep = this.steps;
    }

    haStep() {
        const s = this.st(this.entity);
        if (this.isFanEntity) return s?.state === "on" ? (num(s.attributes?.percentage) ?? 100) : 0;
        return Math.round(num(s?.state) ?? 0);
    }

    fanMode(step) {
        if (step <= 0) return FanControl.FanMode.Off;
        const ratio = step / this.steps;
        return ratio <= 1 / 3 ? FanControl.FanMode.Low : ratio <= 2 / 3 ? FanControl.FanMode.Medium : FanControl.FanMode.High;
    }

    fanState(step) {
        const percent = stepToPercent(step, this.steps);
        return { fanMode: this.fanMode(step), percentSetting: percent, percentCurrent: percent };
    }

    definition() {
        return {
            type: FanDevice,
            state: {
                fanControl: { fanModeSequence: FanControl.FanModeSequence.OffLowMedHigh, ...this.fanState(this.haStep()) },
            },
        };
    }

    listen() {
        const ev = this.endpoint.events.fanControl;
        // Keep fanMode and percentSetting consistent as required by the Matter spec.
        ev.percentSetting$Changed.on(async percent => {
            if (percent === null || percent === undefined) return;
            const step = percentToStep(percent, this.steps);
            await this.endpoint.set({ fanControl: { fanMode: this.fanMode(step), percentCurrent: percent } });
        });
        ev.fanMode$Changed.on(async mode => {
            const current = percentToStep(this.endpoint.state.fanControl.percentSetting ?? 0, this.steps);
            let step;
            switch (mode) {
                case FanControl.FanMode.Off:
                    step = 0;
                    break;
                case FanControl.FanMode.Low:
                    step = current > 0 && current <= this.steps / 3 ? current : Math.ceil(this.steps / 3);
                    break;
                case FanControl.FanMode.Medium:
                    step = current > this.steps / 3 && current <= (2 * this.steps) / 3 ? current : Math.ceil(this.steps / 2);
                    break;
                case FanControl.FanMode.High:
                    step = current > (2 * this.steps) / 3 ? current : this.steps;
                    break;
                default: // On / Auto / Smart
                    step = current || this.lastStep;
            }
            const percent = stepToPercent(step, this.steps);
            if (this.endpoint.state.fanControl.percentSetting !== percent) {
                await this.endpoint.set({ fanControl: { percentSetting: percent, percentCurrent: percent } });
            }
        });
        this.on(ev.percentSetting$Changed, () => {});
        this.on(ev.fanMode$Changed, () => {});
    }

    fromHa() {
        const step = this.haStep();
        if (step > 0) this.lastStep = step;
        return { fanControl: this.fanState(step) };
    }

    async flush() {
        const step = percentToStep(this.endpoint.state.fanControl.percentSetting ?? 0, this.steps);
        if (step === this.haStep()) return;
        if (step > 0) this.lastStep = step;
        if (this.isFanEntity) {
            if (step === 0) await this.call(this.entity, "turn_off");
            else await this.call(this.entity, "set_percentage", { percentage: step });
        } else {
            await this.call(this.entity, "set_value", { value: step });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Climate entity (Proflame WiFi thermostat) -> heat-only Matter thermostat.
const HeatingThermostatServer = ThermostatServer.with("Heating");

export class ThermostatAccessory extends Accessory {
    static kind = "Thermostat";

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
        const a = this.st(entityId)?.attributes ?? {};
        this.unit = ctx.unit;
        this.min = haTempToMatter(num(a.min_temp) ?? (this.unit === "°F" ? 50 : 10), this.unit);
        this.max = haTempToMatter(num(a.max_temp) ?? (this.unit === "°F" ? 90 : 32), this.unit);
        this.step = num(a.target_temp_step) ?? (this.unit === "°F" ? 1 : 0.5);
    }

    #clamp(v) {
        return Math.min(this.max, Math.max(this.min, v));
    }

    #haState() {
        const s = this.st(this.entity);
        const a = s?.attributes ?? {};
        const state = {
            systemMode: s?.state === "off" ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat,
            thermostatRunningState: { heat: a.hvac_action === "heating" },
        };
        const target = num(a.temperature);
        if (target !== undefined) state.occupiedHeatingSetpoint = this.#clamp(haTempToMatter(target, this.unit));
        const current = num(a.current_temperature);
        if (current !== undefined) {
            // matter.js does not always propagate external measurements to localTemperature, so set both
            state.externalMeasuredIndoorTemperature = haTempToMatter(current, this.unit);
            state.localTemperature = state.externalMeasuredIndoorTemperature;
        }
        return state;
    }

    definition() {
        const ha = this.#haState();
        return {
            type: ThermostatDevice.with(HeatingThermostatServer),
            state: {
                thermostat: {
                    controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
                    absMinHeatSetpointLimit: this.min,
                    absMaxHeatSetpointLimit: this.max,
                    minHeatSetpointLimit: this.min,
                    maxHeatSetpointLimit: this.max,
                    occupiedHeatingSetpoint: ha.occupiedHeatingSetpoint ?? this.min,
                    localTemperature: ha.externalMeasuredIndoorTemperature ?? null,
                    externalMeasuredIndoorTemperature: ha.externalMeasuredIndoorTemperature ?? null,
                    systemMode: ha.systemMode,
                    thermostatRunningState: { heat: false, cool: false, fan: false, ...ha.thermostatRunningState },
                },
            },
        };
    }

    listen() {
        const ev = this.endpoint.events.thermostat;
        this.on(ev.systemMode$Changed, () => {});
        this.on(ev.occupiedHeatingSetpoint$Changed, () => {});
    }

    fromHa() {
        const ha = this.#haState();
        ha.thermostatRunningState = { heat: false, cool: false, fan: false, ...ha.thermostatRunningState };
        return { thermostat: ha };
    }

    async flush() {
        const { systemMode, occupiedHeatingSetpoint } = this.endpoint.state.thermostat;
        const s = this.st(this.entity);
        const haOff = s?.state === "off";
        if (systemMode === Thermostat.SystemMode.Off) {
            if (!haOff) await this.call(this.entity, "set_hvac_mode", { hvac_mode: "off" });
            return;
        }
        if (haOff) await this.call(this.entity, "set_hvac_mode", { hvac_mode: "heat" });
        const target = matterTempToHa(occupiedHeatingSetpoint, this.unit, this.step);
        if (target !== num(s?.attributes?.temperature)) {
            await this.call(this.entity, "set_temperature", { temperature: target });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Temperature sensor (room temperature sensor entity, or a climate entity's current_temperature).
export class TemperatureAccessory extends Accessory {
    static kind = "Temperature";

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
    }

    #measured() {
        const s = this.st(this.entity);
        const value = this.entity.startsWith("climate.") ? num(s?.attributes?.current_temperature) : num(s?.state);
        const unit = s?.attributes?.unit_of_measurement ?? this.ctx.unit;
        return value === undefined ? null : haTempToMatter(value, unit);
    }

    definition() {
        return { type: TemperatureSensorDevice, state: { temperatureMeasurement: { measuredValue: this.#measured() } } };
    }

    fromHa() {
        return { temperatureMeasurement: { measuredValue: this.#measured() } };
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Switch-like accessories exposed as Matter on/off plug-in units (Apple Home lets you show them as switches).
class OnOffAccessory extends Accessory {
    static kind = "Switch";

    haOn() {
        return false;
    }
    definition() {
        return { type: OnOffPlugInUnitDevice, state: { onOff: { onOff: this.haOn() } } };
    }
    listen() {
        this.on(this.endpoint.events.onOff.onOff$Changed, () => {});
    }
    fromHa() {
        return { onOff: { onOff: this.haOn() } };
    }
}

/** switch / input_boolean entity (front burner, aux, continuous pilot, ...). */
export class SwitchAccessory extends OnOffAccessory {
    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], options);
        this.entity = entityId;
    }
    haOn() {
        return this.isOn(this.entity);
    }
    async flush() {
        const on = this.endpoint.state.onOff.onOff;
        if (on !== this.haOn()) await this.call(this.entity, on ? "turn_on" : "turn_off");
    }
}

/** Selects a climate preset (smart / eco / manual). Turning the active preset off turns the fireplace off. */
export class PresetAccessory extends OnOffAccessory {
    static kind = "Mode";

    constructor(ctx, id, name, climateId, preset, options) {
        super(ctx, id, name, [climateId], options);
        this.entity = climateId;
        this.preset = preset;
    }
    haOn() {
        const s = this.st(this.entity);
        return !!s && s.state !== "off" && s.attributes?.preset_mode === this.preset;
    }
    async flush() {
        const on = this.endpoint.state.onOff.onOff;
        if (on === this.haOn()) return;
        if (on) await this.call(this.entity, "set_preset_mode", { preset_mode: this.preset });
        else await this.call(this.entity, "set_hvac_mode", { hvac_mode: "off" });
    }
}

/** Sets the auto-off timer number to a fixed number of minutes. */
export class TimerPresetAccessory extends OnOffAccessory {
    static kind = "Timer";

    constructor(ctx, id, name, timerId, minutes, allPresets, options) {
        super(ctx, id, name, [timerId], options);
        this.entity = timerId;
        this.minutes = minutes;
        this.presets = [...allPresets].sort((a, b) => a - b);
        this.ctx.timerState ??= {};
    }
    get lastSet() {
        return this.ctx.timerState[this.entity];
    }
    haOn() {
        const v = this.value(this.entity) ?? 0;
        if (v <= 0) return false;
        if (this.presets.includes(this.lastSet)) return this.lastSet === this.minutes;
        // Timer set elsewhere: light up the smallest preset that covers the remaining time
        return this.presets.find(p => p >= v) === this.minutes || (v > this.presets.at(-1) && this.minutes === this.presets.at(-1));
    }
    async flush() {
        const on = this.endpoint.state.onOff.onOff;
        if (on === this.haOn()) return;
        if (on) {
            this.ctx.timerState[this.entity] = this.minutes;
            await this.call(this.entity, "set_value", { value: this.minutes });
        } else {
            this.ctx.timerState[this.entity] = undefined;
            await this.call(this.entity, "set_value", { value: 0 });
        }
        // Other timer presets must update too
        for (const acc of this.ctx.accessories ?? []) {
            if (acc !== this && acc instanceof TimerPresetAccessory && acc.entity === this.entity) {
                setTimeout(() => acc.refresh(true), 2600);
            }
        }
    }
}

/** button / script entity -> momentary switch that turns itself off again. */
export class MomentaryAccessory extends OnOffAccessory {
    static kind = "Button";

    constructor(ctx, id, name, entityId, options) {
        super(ctx, id, name, [entityId], { ...options, debounceMs: 50 });
        this.entity = entityId;
    }
    async flush() {
        if (!this.endpoint.state.onOff.onOff) return;
        const domain = this.entity.split(".")[0];
        await this.call(this.entity, domain === "button" ? "press" : "turn_on");
        setTimeout(() => this.refresh(true), 1000);
    }
}
