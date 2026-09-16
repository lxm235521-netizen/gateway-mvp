"use strict";

/**
 * Persistence for gateway-wide settings, currently the shared defaults of the
 * optional prompt optimizer. Kept separate from the factory in admin-api.js so
 * that the server can create the table during startup without re-importing the
 * admin router.
 */

const OPTIMIZER_SETTINGS_KEY = "prompt_optimizer_defaults";

async function ensureSettingsTable(db) {
    await db.run(`CREATE TABLE IF NOT EXISTS gateway_settings (
        setting_key VARCHAR(191) PRIMARY KEY,
        setting_value LONGTEXT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Returns {} when the setting is unset or unreadable so callers never have to
// null-check before reading individual fields.
async function readSetting(db, key) {
    const row = await db.get("SELECT setting_value FROM gateway_settings WHERE setting_key = ?", [key]);
    if (!row || !row.setting_value) {
        return {};
    }
    try {
        const parsed = JSON.parse(row.setting_value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

async function writeSetting(db, key, value) {
    const serialized = JSON.stringify(value);
    const updated = await db.run("UPDATE gateway_settings SET setting_value = ? WHERE setting_key = ?", [serialized, key]);
    if (!updated || updated.affectedRows === 0) {
        await db.run("INSERT INTO gateway_settings (setting_key, setting_value) VALUES (?, ?)", [key, serialized]);
    }
}

function readOptimizerDefaults(db) {
    return readSetting(db, OPTIMIZER_SETTINGS_KEY);
}

function writeOptimizerDefaults(db, settings) {
    return writeSetting(db, OPTIMIZER_SETTINGS_KEY, settings);
}

module.exports = {
    ensureSettingsTable,
    readOptimizerDefaults,
    writeOptimizerDefaults,
    OPTIMIZER_SETTINGS_KEY
};
