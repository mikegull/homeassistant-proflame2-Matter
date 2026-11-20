// Finds the entities that belong to each Proflame fireplace in Home Assistant and assigns them roles.
//
// Supported integrations (both are auto-detected):
//   proflame2      - jeffgregx2/HACS-Proflame2 (RF via ESPHome/CC1101 or YardStick One)
//   proflame_wifi  - psaab/proflame_wifi (Proflame WiFi module)
// Any other integration works too when the entities are listed explicitly in the config.

export const KNOWN_INTEGRATIONS = ["proflame2", "proflame_wifi", "proflame"];

/** Role -> [domain(s), name pattern]. Order matters: the first matching role wins. */
const ROLE_RULES = [
    ["thermostat", ["climate"], /.*/],
    ["timer", ["number"], /timer/],
    ["flame", ["number"], /flame/],
    ["fan", ["number", "fan"], /\b(fan|blower)\b/],
    ["light_level", ["number"], /\blight\b/],
    ["accent_light", ["light"], /accent|down ?light|^light$/],
    ["led_strip", ["light"], /led|strip|rgb/],
    ["front_burner", ["switch"], /front|split/],
    ["aux", ["switch"], /\baux/],
    ["pilot", ["switch"], /pilot|\bcpi\b|\bipi\b/],
    ["thermostat_switch", ["switch"], /thermostat/],
    ["power", ["switch"], /\bpower\b|^fireplace$/],
    ["room_temperature", ["sensor"], /temp/],
];

/** Entities we never expose (diagnostics / integration internals). */
const IGNORE = /logging|payload|learning|remote id|wifi|signal|firmware|last |rf band/;

/** Domains that can be exposed generically when no role matches. */
const GENERIC_DOMAINS = new Set(["switch", "light", "number", "button", "fan", "input_boolean", "script"]);

export const ROLES = ROLE_RULES.map(r => r[0]);

function friendlyName(entity, states, deviceName) {
    let name =
        entity.name ?? entity.original_name ?? states.get(entity.entity_id)?.attributes?.friendly_name ?? null;
    if (!name) name = entity.entity_id.split(".")[1].replace(/_/g, " ");
    if (deviceName && name.toLowerCase().startsWith(deviceName.toLowerCase())) {
        name = name.slice(deviceName.length).trim() || name;
    }
    return name;
}

/**
 * Builds the list of fireplaces with their entity roles.
 * @returns {Array<{id, name, entities: Record<string,string>, extras: Array<{entity_id,name}>, options}>}
 */
export async function discoverFireplaces(ha, config, log = console) {
    const states = ha.states;
    let entityRegistry = [];
    let deviceRegistry = [];
    try {
        [entityRegistry, deviceRegistry] = await Promise.all([ha.entityRegistry(), ha.deviceRegistry()]);
    } catch (err) {
        log.warn(`Could not read the Home Assistant registries (${err.message}); only explicit entities will be used`);
    }
    const devices = new Map(deviceRegistry.map(d => [d.id, d]));
    const byEntity = new Map(entityRegistry.map(e => [e.entity_id, e]));

    const configured = config.fireplaces?.length ? config.fireplaces : [{}];
    const result = [];

    for (const fpConfig of configured) {
        const integrations = fpConfig.integration ? [fpConfig.integration] : KNOWN_INTEGRATIONS;
        const candidates = entityRegistry.filter(
            e => integrations.includes(e.platform) && !e.disabled_by && e.device_id,
        );

        // Group by device
        const groups = new Map();
        for (const e of candidates) {
            if (!groups.has(e.device_id)) groups.set(e.device_id, []);
            groups.get(e.device_id).push(e);
        }

        let deviceIds = [...groups.keys()];
        if (fpConfig.device) {
            const wanted = String(fpConfig.device).toLowerCase();
            deviceIds = deviceIds.filter(id => {
                const d = devices.get(id);
                return (
                    id === fpConfig.device ||
                    d?.name_by_user?.toLowerCase() === wanted ||
                    d?.name?.toLowerCase() === wanted
                );
            });
            if (!deviceIds.length && !fpConfig.entities) {
                log.warn(`No Home Assistant device named "${fpConfig.device}" found for integration(s) ${integrations}`);
            }
        }

        // Explicitly configured fireplace without a matching device: use only the listed entities.
        if (!deviceIds.length && fpConfig.entities) deviceIds = [null];

        // With several fireplace devices and one config block without `device`, expose them all.
        for (const deviceId of deviceIds) {
            const device = deviceId ? devices.get(deviceId) : undefined;
            const deviceName = device?.name_by_user ?? device?.name ?? fpConfig.name ?? "Fireplace";
            const entities = {};
            const extras = [];

            for (const entity of deviceId ? groups.get(deviceId) : []) {
                if (entity.entity_category || entity.hidden_by) continue;
                const domain = entity.entity_id.split(".")[0];
                const name = friendlyName(entity, states, deviceName);
                const lname = name.toLowerCase();
                if (IGNORE.test(lname)) continue;

                const deviceClass =
                    entity.device_class ??
                    entity.original_device_class ??
                    states.get(entity.entity_id)?.attributes?.device_class;
                const rule = ROLE_RULES.find(
                    ([role, domains, pattern]) =>
                        domains.includes(domain) &&
                        !entities[role] &&
                        (role === "room_temperature" ? deviceClass === "temperature" : pattern.test(lname)),
                );
                if (rule) entities[rule[0]] = entity.entity_id;
                else if (GENERIC_DOMAINS.has(domain)) extras.push({ entity_id: entity.entity_id, name });
            }

            // Explicit overrides (null/false removes a role)
            for (const [role, entityId] of Object.entries(fpConfig.entities ?? {})) {
                if (entityId) entities[role] = entityId;
                else delete entities[role];
            }
            for (const extra of fpConfig.extra ?? []) {
                const entityId = typeof extra === "string" ? extra : extra.entity_id;
                const name =
                    (typeof extra === "object" && extra.name) ||
                    friendlyName(byEntity.get(entityId) ?? { entity_id: entityId }, states, deviceName);
                extras.push({ entity_id: entityId, name, as: typeof extra === "object" ? extra.as : undefined });
            }

            const name = (deviceIds.length === 1 && fpConfig.name) || deviceName;
            result.push({
                id: fpConfig.id ?? deviceId ?? name,
                name,
                label: (deviceIds.length === 1 && fpConfig.label) || name,
                entities,
                extras,
                options: {
                    steps: fpConfig.steps ?? 6,
                    timerPresets: fpConfig.timer_presets ?? [30, 60, 120, 240],
                    presetSwitches: fpConfig.preset_switches ?? true,
                    expose: fpConfig.expose ?? {},
                    debounceMs: fpConfig.debounce_ms ?? 600,
                },
            });
        }
    }

    // Drop roles whose entity does not exist in HA (typo protection)
    for (const fp of result) {
        for (const [role, entityId] of Object.entries(fp.entities)) {
            if (!states.has(entityId)) {
                log.warn(`[${fp.name}] ${role}: entity ${entityId} does not exist in Home Assistant, skipping`);
                delete fp.entities[role];
            }
        }
        fp.extras = fp.extras.filter(x => states.has(x.entity_id));
    }
    return result;
}
