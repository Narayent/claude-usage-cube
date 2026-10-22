import {percentToColor, UNKNOWN_COLOR} from '../claude-usage-cube@local/color.js';
import {test, eq, finish} from './lib.js';

test('stops are exact', () => {
    eq(percentToColor(0), '#228b22');
    eq(percentToColor(50), '#f6d32d');
    eq(percentToColor(75), '#ff7800');
    eq(percentToColor(90), '#e01b24');
});

test('solid forest green up to 30 %', () => {
    eq(percentToColor(15), '#228b22');
    eq(percentToColor(25), '#228b22');
    eq(percentToColor(30), '#228b22');
});

test('interpolates between stops', () => {
    eq(percentToColor(40), '#8caf28');   // halfway green -> yellow
    eq(percentToColor(62.5), '#fba617'); // halfway yellow -> orange
});

test('90 and above is red', () => {
    eq(percentToColor(100), '#e01b24');
    eq(percentToColor(150), '#e01b24');
});

test('below zero clamps to green', () => {
    eq(percentToColor(-5), '#228b22');
});

test('non-numbers are grey', () => {
    eq(percentToColor(NaN), UNKNOWN_COLOR);
    eq(percentToColor(Infinity), UNKNOWN_COLOR);
    eq(percentToColor(null), UNKNOWN_COLOR);
    eq(percentToColor('42'), UNKNOWN_COLOR);
});

finish();
