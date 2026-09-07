import test from "node:test";

// Retain the dedicated feature tests while the production History tab is off.
// Authentication/tenant-isolation tests in mixed suites remain enabled.
export default process.env.CODEY_SESSION_HISTORY_TESTS === "1" ? test : test.skip;
