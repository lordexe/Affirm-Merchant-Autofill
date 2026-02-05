(() => {
  // plugin/ui.tsx
  var _a;
  var root = (_a = document.getElementById("root")) != null ? _a : document.createElement("div");
  root.style.fontFamily = "Inter, sans-serif";
  root.style.padding = "16px";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "12px";
  root.innerHTML = `
  <label style="font-size: 12px; font-weight: 600;">Merchant names (comma-separated)</label>
  <textarea id="merchant-input" rows="5" style="width: 100%; font-size: 12px;"></textarea>
  <button id="run-button" style="padding: 8px 12px; font-size: 12px;">Run</button>
`;
  if (!root.parentElement) {
    document.body.appendChild(root);
  }
  var input = document.getElementById("merchant-input");
  var button = document.getElementById("run-button");
  button == null ? void 0 : button.addEventListener("click", () => {
    const merchantString = (input == null ? void 0 : input.value) || "";
    parent.postMessage(
      { pluginMessage: { type: "RUN_MERCHANT_AUTOFILL", payload: merchantString } },
      "*"
    );
  });
})();
//# sourceMappingURL=ui.js.map
