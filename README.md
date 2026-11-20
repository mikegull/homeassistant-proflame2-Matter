# Home Assistant Proflame 2 → Matter

Control a Proflame 2 gas fireplace from Apple Home (HomeKit), or any other Matter controller, through Home
Assistant.

This repository is a Home Assistant add-on repository with one add-on:

* **[Fireplace Matter Bridge](fireplace_matter_bridge/)**: a Matter bridge that exposes every fireplace control
  from the Proflame Home Assistant integrations (`proflame2` and `proflame_wifi`) as Matter devices. That covers
  flame on/off and height, blower, lights and LED strip, front burner, aux, pilot, thermostat, Smart/Eco/Manual
  modes, the auto-off timer and room temperature.

To install it, add this repository in **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, or copy the
`fireplace_matter_bridge` folder to `/addons/` on your Home Assistant. See the
[add-on README](fireplace_matter_bridge/README.md) for setup, pairing and configuration.
