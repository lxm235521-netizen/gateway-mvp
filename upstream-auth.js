const AUTH_TYPES = new Set(["bearer", "x-auth-token"]);

function normalizeAuthType(value) {
    const type = value || "bearer";
    if (!AUTH_TYPES.has(type)) throw new Error("Unsupported upstream auth type");
    return type;
}

function buildAuthHeaders(key, authType) {
    const type = normalizeAuthType(authType);
    if (!key) return {};
    return type === "x-auth-token"
        ? { "X-Auth-Token": key }
        : { "Authorization": `Bearer ${key}` };
}

module.exports = { normalizeAuthType, buildAuthHeaders };
