// Kept outside the renderer so expiry survives a reload or renderer crash.
exports.createSecretClipboard = (clipboard) => {
  let secret = null;
  let timer;
  const clear = () => {
    clearTimeout(timer);
    try { if (secret !== null && clipboard.readText() === secret) clipboard.clear(); }
    finally { secret = null; }
  };
  return {
    clear,
    copy(text) {
      clear();
      clipboard.writeText(text);
      secret = text;
      timer = setTimeout(clear, 30_000);
    },
  };
};
