// Turns a discovered fireplace (entity roles) into the list of Matter accessories.

import {
    FanAccessory,
    FlameAccessory,
    HaLightAccessory,
    MomentaryAccessory,
    NumberLightAccessory,
    PresetAccessory,
    SwitchAccessory,
    TemperatureAccessory,
    ThermostatAccessory,
    TimerPresetAccessory,
} from "./accessories.js";

const title = s => s.replace(/(^|[\s_])([a-z])/g, (_, sp, c) => `${sp === "_" ? " " : sp}${c.toUpperCase()}`);

function formatMinutes(m) {
    if (m % 60 === 0) return `${m / 60}h`;
    if (m > 60) return `${Math.floor(m / 60)}h${m % 60}m`;
    return `${m} min`;
}

export function buildAccessories(ctx, fp) {
    const e = fp.entities;
    const o = fp.options;
    const expose = role => o.expose[role] !== false;
    const prefix = fp.label;
    const id = fp.id;
    const list = [];
    // Matter node labels are limited to 32 characters: shorten "Great Room Fireplace Front Burner" smartly.
    const n = suffix => {
        const full = `${prefix} ${suffix}`;
        if (full.length <= 32) return full;
        const short = `${prefix.replace(/\s*fireplace\s*/i, " ").trim()} ${suffix}`;
        return short.length <= 32 ? short : full;
    };

    if ((e.power || e.flame) && expose("flame")) {
        if (!e.power && e.flame) {
            // No power switch: the flame number alone controls the fire (0 = off)
            list.push(new NumberLightAccessory(ctx, `${id}-flame`, prefix, e.flame, o));
        } else {
            list.push(new FlameAccessory(ctx, fp));
        }
    }
    if (e.thermostat && expose("thermostat")) {
        list.push(new ThermostatAccessory(ctx, `${id}-thermostat`, n("Thermostat"), e.thermostat, o));
        const presets = ctx.ha.state(e.thermostat)?.attributes?.preset_modes ?? [];
        if (o.presetSwitches && presets.length && expose("presets")) {
            for (const preset of presets) {
                list.push(
                    new PresetAccessory(ctx, `${id}-preset-${preset}`, n(`${title(preset)} Mode`), e.thermostat, preset, o),
                );
            }
        }
    }
    if (e.fan && expose("fan")) list.push(new FanAccessory(ctx, `${id}-fan`, n("Blower"), e.fan, o));
    if (e.light_level && expose("light_level")) {
        list.push(new NumberLightAccessory(ctx, `${id}-light`, n("Light"), e.light_level, o));
    }
    if (e.accent_light && expose("accent_light")) {
        list.push(new HaLightAccessory(ctx, `${id}-accent`, n("Light"), e.accent_light, o));
    }
    if (e.led_strip && expose("led_strip")) {
        list.push(new HaLightAccessory(ctx, `${id}-led`, n("LED Strip"), e.led_strip, o));
    }
    if (e.front_burner && expose("front_burner")) {
        list.push(new SwitchAccessory(ctx, `${id}-front`, n("Front Burner"), e.front_burner, o));
    }
    if (e.aux && expose("aux")) list.push(new SwitchAccessory(ctx, `${id}-aux`, n("Aux"), e.aux, o));
    if (e.pilot && expose("pilot")) list.push(new SwitchAccessory(ctx, `${id}-pilot`, n("Pilot"), e.pilot, o));
    if (e.thermostat_switch && expose("thermostat_switch") && o.expose.thermostat_switch === true) {
        list.push(new SwitchAccessory(ctx, `${id}-tstat-switch`, n("Thermostat Mode"), e.thermostat_switch, o));
    }
    if (e.timer && expose("timer")) {
        const max = Number(ctx.ha.state(e.timer)?.attributes?.max ?? Infinity);
        const presets = o.timerPresets.filter(m => m > 0 && m <= max);
        for (const minutes of presets) {
            list.push(
                new TimerPresetAccessory(ctx, `${id}-timer-${minutes}`, n(`Timer ${formatMinutes(minutes)}`), e.timer, minutes, presets, o),
            );
        }
    }
    const tempSource = e.room_temperature ?? (e.thermostat && o.expose.room_temperature === true ? e.thermostat : undefined);
    if (tempSource && expose("room_temperature")) {
        list.push(new TemperatureAccessory(ctx, `${id}-temp`, n("Room Temp"), tempSource, o));
    }

    for (const extra of fp.extras) {
        const domain = extra.entity_id.split(".")[0];
        const as = extra.as ?? domain;
        const xid = `${id}-x-${extra.entity_id}`;
        const name = n(extra.name);
        switch (as) {
            case "switch":
            case "input_boolean":
                list.push(new SwitchAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "button":
            case "script":
                list.push(new MomentaryAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "number":
                list.push(new NumberLightAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "light":
                list.push(new HaLightAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "fan":
                list.push(new FanAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "climate":
                list.push(new ThermostatAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            case "sensor":
                list.push(new TemperatureAccessory(ctx, xid, name, extra.entity_id, o));
                break;
            default:
                ctx.log.warn(`[${fp.name}] don't know how to expose ${extra.entity_id}, skipping`);
        }
    }
    return list;
}

/** Human readable summary of what will be exposed. */
export function describe(fp, accessories) {
    const lines = [`Fireplace "${fp.name}"`];
    for (const [role, entityId] of Object.entries(fp.entities)) lines.push(`  role ${role.padEnd(18)} ${entityId}`);
    for (const x of fp.extras) lines.push(`  extra ${x.entity_id} (${x.name})`);
    lines.push("  Matter accessories:");
    for (const a of accessories) lines.push(`    - ${a.name.padEnd(34)} ${a.constructor.name.replace("Accessory", "")}  [${a.entityIds.join(", ")}]`);
    return lines.join("\n");
}
