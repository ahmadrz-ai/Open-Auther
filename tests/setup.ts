/**
 * Silence gateway logs during tests. Individual tests that assert on log
 * output install their own sink via `configureLogging`.
 */

import { configureLogging } from "../src/logging.js";

configureLogging({ level: "error", pretty: false, sink: () => {} });
