// NAME: Duplicate Guard
// AUTHOR: Blackhu4
// DESCRIPTION: Warns before adding a track that is already in a playlist or in Liked Songs
//              (including the same song from a different release), and can scan an existing
//              playlist or Liked Songs for duplicates and remove them after you confirm.

(async function duplicateGuard() {
  while (
    !(
      window.Spicetify &&
      Spicetify.Platform &&
      Spicetify.Platform.PlaylistAPI &&
      Spicetify.Platform.LibraryAPI &&
      Spicetify.CosmosAsync &&
      Spicetify.PopupModal &&
      Spicetify.showNotification
    )
  ) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const PlaylistAPI = Spicetify.Platform.PlaylistAPI;
  const LibraryAPI = Spicetify.Platform.LibraryAPI;
  const LOG = "[Duplicate Guard]";
  const DEBUG = false; // set to true to show on-screen debug notifications
  const dbg = (msg) => {
    console.log(LOG, msg);
    if (DEBUG) Spicetify.showNotification("DG: " + msg);
  };

  // ---------- helpers ----------

  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const keyOf = (name, artist) => `${norm(name)}|${norm(artist)}`;

  const trackId = (uri) => {
    const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri || "");
    return m ? m[1] : null;
  };

  // Name + artist of a single track. Order of attempts:
  // 1) the currently playing track (instant, no network)
  // 2) Spotify's internal GraphQL
  // 3) Web API (may return 429, so it is the last resort)
  async function getOneTrackInfo(uri) {
    try {
      const cur = Spicetify.Player && Spicetify.Player.data && Spicetify.Player.data.item;
      if (cur && cur.uri === uri && cur.name) {
        return { name: cur.name, artist: (cur.artists && cur.artists[0] && cur.artists[0].name) || "" };
      }
    } catch (e) {}

    try {
      const def = Spicetify.GraphQL && Spicetify.GraphQL.Definitions && Spicetify.GraphQL.Definitions.getTrack;
      if (def && Spicetify.GraphQL.Request) {
        const res = await Spicetify.GraphQL.Request(def, { uri });
        const t = (res && res.data && (res.data.trackUnion || res.data.track)) || null;
        if (t && t.name) {
          const a =
            (t.firstArtist && t.firstArtist.items && t.firstArtist.items[0] && t.firstArtist.items[0].profile && t.firstArtist.items[0].profile.name) ||
            (t.artists && t.artists.items && t.artists.items[0] && t.artists.items[0].profile && t.artists.items[0].profile.name) ||
            (t.artists && t.artists[0] && t.artists[0].name) ||
            "";
          return { name: t.name, artist: a };
        }
      }
    } catch (e) {
      console.warn(LOG, "GraphQL error:", e);
    }

    const id = trackId(uri);
    if (!id) return null;
    try {
      const res = await Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${id}`);
      if (res && res.name) return { name: res.name, artist: (res.artists && res.artists[0] && res.artists[0].name) || "" };
    } catch (e) {
      console.warn(LOG, "Web API error (429 = too many requests):", e);
    }
    return null;
  }

  async function getTrackInfo(uris) {
    const info = new Map();
    for (const uri of uris) {
      const meta = await getOneTrackInfo(uri);
      if (meta) info.set(uri, meta);
    }
    if (info.size < uris.length) {
      dbg("Could not fetch details for every track; only identical URIs can be checked");
    }
    return info;
  }

  async function getPlaylistTracks(playlistUri) {
    const contents = await PlaylistAPI.getContents(playlistUri);
    return (contents?.items || []).map((it) => ({
      uri: it.uri,
      uid: it.uid,
      name: it.name,
      artist: it.artists?.[0]?.name || "",
      album: it.album?.name || "",
    }));
  }

  // Liked Songs via the Web API, paginated (cached for 60 s)
  let likedCache = null;
  let likedCacheTime = 0;
  async function getLikedTracks() {
    if (likedCache && Date.now() - likedCacheTime < 60000) return likedCache;
    const out = [];
    let url = "https://api.spotify.com/v1/me/tracks?limit=50";
    while (url) {
      const res = await Spicetify.CosmosAsync.get(url);
      for (const it of res.items || []) {
        if (it.track) {
          out.push({
            uri: it.track.uri,
            name: it.track.name,
            artist: it.track.artists?.[0]?.name || "",
            album: it.track.album?.name || "",
          });
        }
      }
      url = res.next;
    }
    likedCache = out;
    likedCacheTime = Date.now();
    return out;
  }

  // Duplicate lookup: same URI, or same title + artist
  async function findDuplicates(existing, uris) {
    const existingUris = new Set(existing.map((t) => t.uri));
    const existingKeys = new Set(existing.filter((t) => t.name).map((t) => keyOf(t.name, t.artist)));
    const info = await getTrackInfo(uris);

    const dupes = [];
    const fresh = [];
    for (const uri of uris) {
      const meta = info.get(uri);
      const label = meta ? `${meta.artist} – ${meta.name}` : uri;
      if (existingUris.has(uri)) {
        dupes.push({ uri, label, reason: "exact same track" });
      } else if (meta && existingKeys.has(keyOf(meta.name, meta.artist))) {
        dupes.push({ uri, label, reason: "same title and artist, different release" });
      } else {
        fresh.push(uri);
      }
    }
    return { dupes, fresh };
  }

  const buttonStyle = (primary) =>
    "padding:8px 16px;border-radius:500px;border:none;cursor:pointer;font-weight:700;" +
    (primary
      ? "background:var(--spice-button,#1db954);color:var(--spice-main,#000);"
      : "background:var(--spice-card,#333);color:var(--spice-text,#fff);");

  // Resolves `onClose` if the user dismisses the modal with the X button
  function watchModalClosed(wrap, isDone, onClose) {
    let seen = false;
    const poll = setInterval(() => {
      if (isDone()) return clearInterval(poll);
      if (wrap.isConnected) seen = true;
      else if (seen) {
        clearInterval(poll);
        onClose();
      }
    }, 400);
  }

  // ---------- "add anyway?" dialog: resolves "skip" | "add" | "cancel" ----------

  function askUser(dupes, totalCount, targetName) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        Spicetify.PopupModal.hide();
        resolve(val);
      };

      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;";

      const text = document.createElement("div");
      text.textContent =
        totalCount === 1
          ? `This track is already in ${targetName}`
          : `${dupes.length} of ${totalCount} tracks are already in ${targetName}`;
      wrap.appendChild(text);

      const list = document.createElement("ul");
      list.style.cssText = "margin:0;padding-left:18px;max-height:200px;overflow:auto;";
      for (const d of dupes) {
        const li = document.createElement("li");
        li.textContent = `${d.label} (${d.reason})`;
        list.appendChild(li);
      }
      wrap.appendChild(list);

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
      const mkBtn = (label, val, primary) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = buttonStyle(primary);
        b.onclick = () => finish(val);
        return b;
      };
      row.appendChild(mkBtn("Cancel", "cancel", totalCount === 1));
      row.appendChild(mkBtn("Add anyway", "add", false));
      if (totalCount > 1) row.appendChild(mkBtn("Skip duplicates", "skip", true));
      wrap.appendChild(row);

      Spicetify.PopupModal.display({ title: "Duplicate found", content: wrap });
      watchModalClosed(wrap, () => done, () => finish("cancel"));
    });
  }

  // Returns the URIs that should really be added, or null (cancelled)
  async function guard(existing, uris, targetName) {
    const { dupes, fresh } = await findDuplicates(existing, uris);
    if (dupes.length === 0) return uris;

    const choice = await askUser(dupes, uris.length, targetName);
    if (choice === "cancel") {
      Spicetify.showNotification("Adding cancelled");
      return null;
    }
    if (choice === "add") return uris;
    if (fresh.length === 0) {
      Spicetify.showNotification("All tracks were already there, skipped");
      return null;
    }
    Spicetify.showNotification(`${dupes.length} duplicate(s) skipped`);
    return fresh;
  }

  // ---------- wrap PlaylistAPI.add ----------

  try {
    const originalPlaylistAdd = PlaylistAPI.add.bind(PlaylistAPI);
    PlaylistAPI.add = async function (playlistUri, uris, ...rest) {
      dbg("PlaylistAPI.add called");
      try {
        if (!playlistUri || !playlistUri.startsWith("spotify:playlist:") || !Array.isArray(uris)) {
          return originalPlaylistAdd(playlistUri, uris, ...rest);
        }
        const existing = await getPlaylistTracks(playlistUri);
        const toAdd = await guard(existing, uris, "this playlist");
        if (toAdd === null) return;
        return originalPlaylistAdd(playlistUri, toAdd, ...rest);
      } catch (e) {
        console.error(LOG, "Check failed, adding the original way:", e);
        return originalPlaylistAdd(playlistUri, uris, ...rest);
      }
    };
  } catch (e) {
    console.error(LOG, "Could not wrap PlaylistAPI.add:", e);
  }

  // ---------- wrap LibraryAPI add methods (Liked Songs / heart button) ----------

  const libraryMethods = [];
  for (const name of ["add", "addTracks", "save", "like"]) {
    if (typeof LibraryAPI[name] !== "function") continue;
    try {
      const original = LibraryAPI[name].bind(LibraryAPI);
      LibraryAPI[name] = async function (arg, ...rest) {
        dbg(`LibraryAPI.${name} called`);
        try {
          const uris = Array.isArray(arg) ? arg : arg?.uris;
          if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => trackId(u))) {
            return original(arg, ...rest);
          }
          const liked = await getLikedTracks();
          const toAdd = await guard(liked, uris, "your Liked Songs");
          if (toAdd === null) return;
          const newArg = Array.isArray(arg) ? toAdd : { ...arg, uris: toAdd };
          const result = await original(newArg, ...rest);
          likedCache = null;
          return result;
        } catch (e) {
          dbg("error: " + (e && e.message ? e.message : e));
          console.error(LOG, e);
          return original(arg, ...rest);
        }
      };
      libraryMethods.push(name);
    } catch (e) {
      console.error(LOG, `Could not wrap LibraryAPI.${name}:`, e);
    }
  }

  // ---------- scan a whole playlist / Liked Songs ----------

  const LIKED_RE = /^spotify:user:[^:]+:collection$/;

  // Groups of tracks that share the same title + artist
  function findGroups(items) {
    const map = new Map();
    for (const it of items) {
      if (!it.name) continue;
      const k = keyOf(it.name, it.artist);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return [...map.values()].filter((g) => g.length > 1);
  }

  // Confirmation dialog. Resolves with the items to remove, or null (cancelled)
  function askRemoval(groups, targetName) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        Spicetify.PopupModal.hide();
        resolve(val);
      };

      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;";

      const intro = document.createElement("div");
      intro.textContent =
        `${groups.length} track(s) appear more than once in ${targetName}. ` +
        `Checked copies will be removed, unchecked ones are kept (at least one copy of each track always stays).`;
      wrap.appendChild(intro);

      const scroll = document.createElement("div");
      scroll.style.cssText = "max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:10px;";
      wrap.appendChild(scroll);

      const entries = []; // { item, box }
      const removeBtn = document.createElement("button");

      const updateCount = () => {
        const n = entries.filter((e) => e.box.checked).length;
        removeBtn.textContent = `Remove selected (${n})`;
        removeBtn.disabled = n === 0;
        removeBtn.style.opacity = n === 0 ? "0.5" : "1";
      };

      for (const group of groups) {
        const section = document.createElement("div");
        const head = document.createElement("div");
        head.style.cssText = "font-weight:700;margin-bottom:4px;";
        head.textContent = `${group[0].artist} – ${group[0].name}`;
        section.appendChild(head);

        const groupEntries = [];
        group.forEach((item, idx) => {
          const label = document.createElement("label");
          label.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer;padding-left:8px;";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = idx > 0; // the first copy is kept by default
          const sameUri = group.some((o) => o !== item && o.uri === item.uri);
          const span = document.createElement("span");
          span.textContent =
            (item.album || "unknown album") +
            (sameUri ? " (exact same track)" : "") +
            (idx === 0 ? " – first occurrence" : "");
          label.appendChild(cb);
          label.appendChild(span);
          section.appendChild(label);

          const entry = { item, box: cb };
          groupEntries.push(entry);
          entries.push(entry);

          cb.addEventListener("change", () => {
            if (groupEntries.every((e) => e.box.checked)) {
              cb.checked = false;
              Spicetify.showNotification("At least one copy has to stay");
            }
            updateCount();
          });
        });
        scroll.appendChild(section);
      }

      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = buttonStyle(false);
      cancelBtn.onclick = () => finish(null);
      removeBtn.style.cssText = buttonStyle(true);
      removeBtn.onclick = () => finish(entries.filter((e) => e.box.checked).map((e) => e.item));
      row.appendChild(cancelBtn);
      row.appendChild(removeBtn);
      wrap.appendChild(row);
      updateCount();

      Spicetify.PopupModal.display({ title: "Duplicates found", content: wrap });
      watchModalClosed(wrap, () => done, () => finish(null));
    });
  }

  let scanning = false;
  async function scanForDuplicates(uri, isLiked) {
    if (scanning) return;
    scanning = true;
    try {
      Spicetify.showNotification("Scanning for duplicates...");

      let items;
      if (isLiked) {
        likedCache = null;
        items = await getLikedTracks();
      } else {
        items = await getPlaylistTracks(uri);
      }

      const groups = findGroups(items);
      if (groups.length === 0) {
        Spicetify.showNotification(`No duplicates found (${items.length} tracks checked)`);
        return;
      }

      const chosen = await askRemoval(groups, isLiked ? "your Liked Songs" : "this playlist");
      if (!chosen || chosen.length === 0) {
        Spicetify.showNotification("Nothing was removed");
        return;
      }

      if (isLiked) {
        const ids = [...new Set(chosen.map((c) => trackId(c.uri)).filter(Boolean))];
        for (let i = 0; i < ids.length; i += 50) {
          await Spicetify.CosmosAsync.del("https://api.spotify.com/v1/me/tracks", { ids: ids.slice(i, i + 50) });
        }
        likedCache = null;
      } else {
        await PlaylistAPI.remove(
          uri,
          chosen.map((c) => ({ uri: c.uri, uid: c.uid }))
        );
      }
      Spicetify.showNotification(`${chosen.length} track(s) removed`);
    } catch (e) {
      console.error(LOG, "Scan failed:", e);
      Spicetify.showNotification("Duplicate Guard: scan failed – " + (e && e.message ? e.message : e), true);
    } finally {
      scanning = false;
    }
  }

  // Right-click menu on playlists and Liked Songs
  try {
    if (Spicetify.ContextMenu && Spicetify.ContextMenu.Item) {
      new Spicetify.ContextMenu.Item(
        "Find duplicates",
        (uris) => scanForDuplicates(uris[0], LIKED_RE.test(uris[0])),
        (uris) => uris.length === 1 && (/^spotify:playlist:/.test(uris[0]) || LIKED_RE.test(uris[0])),
        "search"
      ).register();
    }
  } catch (e) {
    console.error(LOG, "Could not register the context menu item:", e);
  }

  // Top bar button: scans the page that is currently open
  try {
    if (Spicetify.Topbar && Spicetify.Topbar.Button) {
      new Spicetify.Topbar.Button("Find duplicates", "search", async () => {
        const path = Spicetify.Platform?.History?.location?.pathname || "";
        const m = /^\/playlist\/([A-Za-z0-9]+)/.exec(path);
        if (m) return scanForDuplicates(`spotify:playlist:${m[1]}`, false);
        if (path.startsWith("/collection/tracks")) return scanForDuplicates("liked", true);
        Spicetify.showNotification("Open a playlist or Liked Songs first");
      });
    }
  } catch (e) {
    console.error(LOG, "Could not create the top bar button:", e);
  }

  console.log(LOG, "loaded", { libraryMethods });
  if (DEBUG) Spicetify.showNotification("Duplicate Guard active. Hooked: " + (libraryMethods.join(", ") || "none"));
})();
