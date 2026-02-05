const queries = text
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

parent.postMessage({ pluginMessage: { type: "POPULATE", queries } }, "*");
