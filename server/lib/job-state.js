'use strict';
// Flags for the long-running background jobs. Shared so the pollers and the routes can see each other's state
// (for example, hub history enrichment stands back while the pre-compute is running). Read and write them as
// jobState.preComputeRunning, never copy them into a local variable.
module.exports = {
  preComputeRunning: false,
  contractIngestRunning: false,
  volumeEnrichmentRunning: false,
};
