import assert from "node:assert/strict";
import { test } from "node:test";
import {
    haTempToMatter,
    levelToStep,
    matterTempToHa,
    percentToStep,
    stepToLevel,
    stepToPercent,
} from "../src/convert.js";

test("flame/light steps round-trip through Matter levels", () => {
    for (let step = 1; step <= 6; step++) assert.equal(levelToStep(stepToLevel(step, 6), 6), step);
    assert.equal(levelToStep(1, 6), 1); // lowest brightness is still "on"
    assert.equal(levelToStep(254, 6), 6);
});

test("fan steps round-trip through Matter percent", () => {
    for (let step = 0; step <= 6; step++) assert.equal(percentToStep(stepToPercent(step, 6), 6), step);
    assert.equal(percentToStep(1, 6), 1); // any non-zero speed keeps the blower running
    assert.equal(percentToStep(100, 6), 6);
});

test("temperatures convert between °F and Matter 0.01 °C", () => {
    assert.equal(haTempToMatter(72, "°F"), 2222);
    assert.equal(matterTempToHa(2222, "°F"), 72);
    for (let f = 50; f <= 90; f++) assert.equal(matterTempToHa(haTempToMatter(f, "°F"), "°F"), f);
    assert.equal(haTempToMatter(21.5, "°C"), 2150);
    assert.equal(matterTempToHa(2150, "°C"), 21.5);
});
