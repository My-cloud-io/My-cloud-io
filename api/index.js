"use strict";

/*
 * Vercel serverless entry point.
 * All /api/* requests are rewritten here by vercel.json.
 */
const app = require("../server");
module.exports = app;
