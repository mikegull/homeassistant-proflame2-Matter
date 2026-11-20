# Fireplace Matter Bridge

Exposes the Proflame 2 fireplace(s) in Home Assistant as **Matter devices**, so Apple Home (HomeKit) can control
every option on the fireplace: on/off, flame height, blower, lights, front burner, aux, pilot, and, on Proflame
WiFi modules, the thermostat, Smart/Eco/Manual modes and the auto-off timer.

It is a small [matter.js](https://github.com/project-chip/matter.js) Matter **bridge**. It talks to Home Assistant
over its WebSocket API and shows up in Apple Home as one bridge with a separate tile per fireplace control. The
bridge works with both Proflame integrations and finds their entities automatically:

| Integration | HA domain | Hardware |
|---|---|---|
| [jeffgregx2/HACS-Proflame2](https://github.com/jeffgregx2/HACS-Proflame2) | `proflame2` | RF via ESPHome (CC1101) or YardStick One |
| [psaab/proflame_wifi](https://github.com/psaab/proflame_wifi) | `proflame_wifi` | Proflame WiFi module |

## What you get in Apple Home

| Apple Home tile | Matter device type | Home Assistant entity | Notes |
|---|---|---|---|
| **Fireplace** | Dimmable light | power `switch` + flame `number` (1–6) | On = fire lit; brightness = flame height (17 % ≈ 1 … 100 % = 6) |
| **Blower** | Fan | fan `number` (0–6) | Speed % maps to blower levels 0–6 |
| **Light** | Dimmable light | light `number` (0–6) *or* accent `light` | Off = 0, brightness = 1–6 |
| **LED Strip** | Extended color light | `light` (RGB) | Colour, brightness (Proflame WiFi) |
| **Front Burner** | Outlet/switch | front burner / split flow `switch` | |
| **Aux** | Outlet/switch | aux `switch` | |
| **Pilot** | Outlet/switch | CPI / continuous pilot `switch` | On = continuous pilot, off = IPI |
| **Thermostat** | Thermostat (heat only) | `climate` | Off/Heat, target temp, current temp, "heating" state (Proflame WiFi) |
| **Smart / Eco / Manual Mode** | Switches | `climate` preset | Work like radio buttons; turning the active one off turns the fireplace off |
| **Timer 30 min / 1h / 2h / 4h** | Switches | auto-off timer `number` | Starts the auto-off timer; off cancels it (Proflame WiFi) |
| **Room Temp** | Temperature sensor | room temperature `sensor` | Usable in Apple Home automations |

Only tiles whose entities exist are created. A `proflame2` setup without a light or fan simply has no Light/Blower
tile. Apple Home shows the switches as outlets by default; to change them, long-press a tile → settings →
*Display As* → Switch.

Tile names are `<device name> <control>`, for example "Great Room Fireplace Blower". Matter limits names to 32
characters, so longer names drop the word "Fireplace" ("Great Room Front Burner"). You can rename tiles in Apple
Home.

Siri works with the tile names: "Hey Siri, set the Great Room Fireplace to 50 %", "turn on the Great Room Fireplace
Blower", "set the Den Fireplace Thermostat to 72".

## Requirements

* Home Assistant with one of the Proflame integrations set up (the chalet HA, `chaletghass`).
* An Apple home hub (HomePod or Apple TV) at the chalet, so Apple Home can reach Matter devices.
* IPv6 enabled on the chalet LAN (Matter needs it; it is on by default on Firewalla and most routers).

## Install as a Home Assistant add-on (recommended)

1. Add the add-on to the chalet Home Assistant, in one of two ways:
   * **From GitHub** (the repository must be public): **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
     add `https://github.com/mikegull/homeassistant-proflame2-Matter`, and install *Fireplace Matter Bridge*.
   * **As a local add-on**: copy this `fireplace_matter_bridge` folder to `/addons/fireplace_matter_bridge` (with
     the *Samba share* or *Advanced SSH & Web Terminal* add-on, e.g.
     `scp -r fireplace_matter_bridge root@chaletghass:/addons/`). Then **Add-on Store → ⋮ → Check for updates**
     and install it from **Local add-ons**.
2. On the **Configuration** tab, set your own 8-digit `passcode` (not 20202021, 12345678, 11111111, …) and change
   the `bridge_name` if you like.
3. Start the add-on and open the **Log** tab. It lists every fireplace control it found, then prints a QR code and
   a manual pairing code.
4. On your iPhone: **Home → + → Add Accessory**, then scan the QR code (or tap *More options* and type the manual
   code). Apple warns that it is an "Uncertified Accessory"; choose **Add Anyway**. Assign the tiles to rooms.

The add-on connects to Home Assistant automatically (no token needed) and stores its pairing data in the add-on's
`/data` folder, so restarts and updates keep the pairing.

**Optional settings.** To pick fireplaces, rename tiles, or hide or add entities, create
`fireplace-matter-bridge.yaml` with a `fireplaces:` section in the add-on's config folder
(`/addon_configs/local_fireplace_matter_bridge/` for a local install, `/addon_configs/<id>_fireplace_matter_bridge/`
when installed from GitHub), as in
[`bridge.example.yaml`](bridge.example.yaml), and restart the add-on.

## Install standalone (Docker or Node.js)

On any always-on Linux machine on the chalet LAN:

```sh
cp bridge.example.yaml bridge.yaml      # set homeassistant.url, homeassistant.token, matter.passcode
npm ci --omit=dev
npm run discover                        # shows what will be exposed, then exits
npm start                               # prints the pairing QR code
```

Or with Docker: `HA_TOKEN=... docker compose up -d`. The container needs `network_mode: host`.

Create the token in Home Assistant under **Profile → Security → Long-lived access tokens**.

## Check the entity mapping

`npm run discover` (or the add-on log at start-up) prints the role assigned to each entity, for example:

```
Fireplace "Great Room Fireplace"
  role power              switch.great_room_fireplace_power
  role flame              number.great_room_fireplace_flame
  role fan                number.great_room_fireplace_fan
  role light_level        number.great_room_fireplace_light
  role front_burner       switch.great_room_fireplace_front_burner
  role aux                switch.great_room_fireplace_aux
  role pilot              switch.great_room_fireplace_cpi
  Matter accessories:
    - Great Room Fireplace               Flame
    - Great Room Fireplace Blower        Fan
    ...
```

If an entity is missing or mapped to the wrong role, fix it under `fireplaces[].entities` in the config. To expose
any other HA entity (a script, a button, another switch), use `fireplaces[].extra`.

## How it behaves

* **Two-way sync.** Changes from the Proflame remote, the HA dashboard or automations show up in Apple Home within
  a second. Changes from Apple Home become Home Assistant service calls (`switch.turn_on`, `number.set_value`,
  `climate.set_temperature`, …).
* **Debouncing.** Dragging a brightness or speed slider sends one command, 600 ms after you let go, not a burst of
  RF commands.
* **Turning the fire on** at a given brightness turns on power first, then sets the flame height.
* **Unavailable** entities, or a lost Home Assistant connection, show the tiles as "Not Responding" in Apple Home.

## Development

```sh
npm install
npm test        # end-to-end tests against a fake Home Assistant (both integrations)
```

Code layout: `src/ha-client.js` is the Home Assistant WebSocket client, `src/discovery.js` assigns entity roles,
`src/accessories.js` holds the Matter endpoints and value mapping, `src/build.js` turns roles into accessories, and
`src/index.js` is the entry point and Matter server.
