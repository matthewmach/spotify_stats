/* worker.js — reads + parses + aggregates the history off the main thread so the
   UI stays responsive and can show real progress. Shares buildDataset with the
   page via shared-build.js. */

importScripts("shared-build.js");

self.onmessage = async (e) => {
  const files = e.data.files || [];
  try {
    const records = [];
    for (let i = 0; i < files.length; i++) {
      let json;
      try { json = JSON.parse(await files[i].text()); } catch (err) { continue; }
      if (Array.isArray(json)) {
        for (const r of json) if (r && (r.ms_played != null || r.ts)) records.push(r);
      }
      self.postMessage({ type: "progress", stage: "reading", i: i + 1, n: files.length, plays: records.length });
    }
    if (!records.length) {
      self.postMessage({ type: "error", message: "No streaming-history records found. Select your Streaming_History_Audio_*.json files." });
      return;
    }
    self.postMessage({ type: "progress", stage: "aggregating", plays: records.length });
    const data = buildDataset(records, (n) => self.postMessage({ type: "progress", stage: "aggregating", plays: n }));
    self.postMessage({ type: "done", data });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
