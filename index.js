// index.js
// Discord.js v14 single-file bot (ESM) — LEAGUE ONLY
//
// Env vars required:
//   DISCORD_TOKEN
//   LEAGUE_PLAYERS_CSV_URL
//   LEAGUE_RESULTS_CSV_URL
//   LEAGUE_HISTORY_CSV_URL

import http from "http";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
  EmbedBuilder,
} from "discord.js";

// ==================================================
// ENV
// ==================================================
const TOKEN = process.env.DISCORD_TOKEN;
const LEAGUE_PLAYERS_CSV_URL = process.env.LEAGUE_PLAYERS_CSV_URL;
const LEAGUE_RESULTS_CSV_URL = process.env.LEAGUE_RESULTS_CSV_URL;
const LEAGUE_HISTORY_CSV_URL = process.env.LEAGUE_HISTORY_CSV_URL;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var");
if (!LEAGUE_PLAYERS_CSV_URL) console.warn("Missing LEAGUE_PLAYERS_CSV_URL env var");
if (!LEAGUE_RESULTS_CSV_URL) console.warn("Missing LEAGUE_RESULTS_CSV_URL env var");
if (!LEAGUE_HISTORY_CSV_URL) console.warn("Missing LEAGUE_HISTORY_CSV_URL env var");

// ==================================================
// HEALTHCHECK
// ==================================================
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on ${PORT}`));

// ==================================================
// CONSTANTS
// ==================================================
const LEAGUE_BATTLEPLANS = [
  "Paths of the Fey",
  "The Liferoots",
  "Surge of Slaughter",
  "Lifecycle",
  "Roiling Roots",
];

const LEAGUE_DEADLINE = new Date("2026-04-08T23:59:59+01:00");

// ==================================================
// CSV PARSER
// ==================================================
function parseCSV(text) {
  text = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && (c === "," || c === "\n")) {
      row.push(field);
      field = "";

      if (c === "\n") {
        if (row.some((x) => String(x ?? "").trim() !== "")) rows.push(row);
        row = [];
      }

      continue;
    }

    field += c;
  }

  row.push(field);
  if (row.some((x) => String(x ?? "").trim() !== "")) rows.push(row);

  if (!rows.length) return [];

  const header = rows[0].map((h) => String(h ?? "").trim());

  return rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? "";
    return obj;
  });
}

// ==================================================
// HELPERS
// ==================================================
function norm(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sameName(a, b) {
  return norm(a) === norm(b);
}

function startsOrIncludes(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  if (!n) return true;
  return h.startsWith(n) || h.includes(n);
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function getCol(row, candidates) {
  for (const c of candidates) {
    if (c in row) return row[c];
  }
  return "";
}

function toNum(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  const cleaned = s.replace(/%/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function nowStr(d = new Date()) {
  return d.toLocaleString("en-GB", { hour12: true });
}

function chunkText(text, max = 1024) {
  const chunks = [];
  let i = 0;

  while (i < text.length) {
    chunks.push(text.slice(i, i + max));
    i += max;
  }

  return chunks;
}

function makeBaseEmbed(title) {
  return new EmbedBuilder().setTitle(title).setFooter({ text: "Woehammer League" });
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function makeChoices(list, typed) {
  return list
    .filter((x) => startsOrIncludes(x, typed))
    .slice(0, 25)
    .map((x) => ({
      name: x.length > 100 ? x.slice(0, 97) + "..." : x,
      value: x,
    }));
}

// ==================================================
// DEADLINE
// ==================================================
function deadlineLines() {
  const deadlineUnix = Math.floor(LEAGUE_DEADLINE.getTime() / 1000);
  const diffMs = LEAGUE_DEADLINE.getTime() - Date.now();

  return [
    `You have until <t:${deadlineUnix}:F> to arrange and play your games.`,
    diffMs <= 0
      ? `This deadline passed <t:${deadlineUnix}:R>.`
      : `This leaves you <t:${deadlineUnix}:R>.`,
  ];
}

// ==================================================
// TABLE RENDERING
// ==================================================
function clampName(name, max = 22) {
  const s = String(name ?? "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function padR(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padL(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function renderStandingsBlock(rows) {
  const NAME_W = 22;
  const WDL_W = 7;
  const PTS_W = 5;

  const header = `${padR("Player", NAME_W)} ${padR("W-D-L", WDL_W)} ${padR("Pts", PTS_W)}`;
  const rule = "-".repeat(header.length);

  const lines = rows.map((r) => {
    const name = clampName(r.player, NAME_W);
    const wdl = `${r.w}-${r.d}-${r.l}`;
    const pts = `[${r.pts}]`;
    return `${padR(name, NAME_W)} ${padR(wdl, WDL_W)} ${padL(pts, PTS_W)}`;
  });

  return ["```", header, rule, ...lines, "```"].join("\n");
}

// ==================================================
// CACHE + FETCH
// ==================================================
let leaguePlayersCache = [];
let leaguePlayersCachedAt = null;

let leagueResultsCache = [];
let leagueResultsCachedAt = null;

let leagueHistoryCache = [];
let leagueHistoryCachedAt = null;

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${Date.now()}`;
}

async function fetchCSV(url, { cacheBust = false } = {}) {
  if (!url) throw new Error("Missing CSV URL env var");

  const finalUrl = cacheBust ? withCacheBust(url) : url;

  const res = await fetch(finalUrl, {
    headers: { "User-Agent": "WoehammerLeagueBot/2.0" },
  });

  if (!res.ok) {
    const err = new Error(`Failed to fetch CSV (${res.status})`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text();
  return parseCSV(text);
}

async function loadLeaguePlayers(force = false) {
  if (!force && leaguePlayersCache.length) return;
  leaguePlayersCache = await fetchCSV(LEAGUE_PLAYERS_CSV_URL, { cacheBust: force });
  leaguePlayersCachedAt = new Date();
}

async function loadLeagueResults(force = false) {
  if (!LEAGUE_RESULTS_CSV_URL) return;
  if (!force && leagueResultsCache.length) return;
  leagueResultsCache = await fetchCSV(LEAGUE_RESULTS_CSV_URL, { cacheBust: force });
  leagueResultsCachedAt = new Date();
}

async function loadLeagueHistory(force = false) {
  if (!LEAGUE_HISTORY_CSV_URL) return;
  if (!force && leagueHistoryCache.length) return;
  leagueHistoryCache = await fetchCSV(LEAGUE_HISTORY_CSV_URL, { cacheBust: force });
  leagueHistoryCachedAt = new Date();
}

async function ensureLeaguePlayers() {
  try {
    await loadLeaguePlayers(false);
  } catch (e) {
    if (!leaguePlayersCache.length) throw e;
    console.warn("League players fetch failed; using cached:", e?.message ?? e);
  }
}

async function ensureLeagueResults() {
  try {
    await loadLeagueResults(false);
  } catch (e) {
    if (!leagueResultsCache.length) throw e;
    console.warn("League results fetch failed; using cached:", e?.message ?? e);
  }
}

async function ensureLeagueHistory() {
  try {
    await loadLeagueHistory(false);
  } catch (e) {
    if (!leagueHistoryCache.length) throw e;
    console.warn("League history fetch failed; using cached:", e?.message ?? e);
  }
}

async function ensureAllLeagueData() {
  await ensureLeaguePlayers();
  await ensureLeagueResults();
  await ensureLeagueHistory();
}

function leagueCachedFooter(embed) {
  const players = leaguePlayersCachedAt ? nowStr(leaguePlayersCachedAt) : "—";
  const results = leagueResultsCachedAt ? nowStr(leagueResultsCachedAt) : "—";
  const history = leagueHistoryCachedAt ? nowStr(leagueHistoryCachedAt) : "—";

  const base = embed.data?.footer?.text || "Woehammer League";

  embed.setFooter({
    text: `${base} • Cached: Players ${players} • Results ${results} • History ${history}`,
  });

  return embed;
}

// ==================================================
// COLUMN HELPERS
// ==================================================
const lpPlayer = (r) => getCol(r, ["Player", "player", "Name", "name"]);
const lpLeague = (r) => getCol(r, ["League", "league"]);
const lpList = (r) => getCol(r, ["Lists", "List", "lists", "list"]);

const lpOpponents = (r) => [
  getCol(r, ["Rnd 1 Opponent", "Round 1 Opponent", "R1 Opponent"]),
  getCol(r, ["Rnd 2 Opponent", "Round 2 Opponent", "R2 Opponent"]),
  getCol(r, ["Rnd 3 Opponent", "Round 3 Opponent", "R3 Opponent"]),
  getCol(r, ["Rnd 4 Opponent", "Round 4 Opponent", "R4 Opponent"]),
  getCol(r, ["Rnd 5 Opponent", "Round 5 Opponent", "R5 Opponent"]),
];

const lpW = (r) => toNum(getCol(r, ["W", "w", "Wins"]));
const lpD = (r) => toNum(getCol(r, ["D", "d", "Draws"]));
const lpL = (r) => toNum(getCol(r, ["L", "l", "Losses"]));
const lpPts = (r) => toNum(getCol(r, ["Pts", "pts", "Points"]));

// ==================================================
// AUTOCOMPLETE LISTS
// ==================================================
function getLeaguePlayers() {
  return uniq(
    leaguePlayersCache
      .map((r) => String(lpPlayer(r) ?? "").trim())
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
}

function getLeagues() {
  return uniq(
    leaguePlayersCache
      .map((r) => String(lpLeague(r) ?? "").trim())
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
}

// ==================================================
// RESULTS MATCHING
// ==================================================
function findGameResult(player, opponent, battleplan) {
  if (!opponent || norm(opponent) === "bye") return null;

  return leagueResultsCache.find((r) => {
    const p1 = getCol(r, ["Player 1", "P1", "player 1"]);
    const p2 = getCol(r, ["Player 2", "P2", "player 2"]);
    const bp = getCol(r, ["Battleplan", "battleplan"]);

    const playersMatch =
      (sameName(player, p1) && sameName(opponent, p2)) ||
      (sameName(player, p2) && sameName(opponent, p1));

    return playersMatch && norm(bp) === norm(battleplan);
  });
}

function formatFixtureLine(player, opponent, battleplan, idx) {
  const oppTxt = String(opponent ?? "").trim() || "—";

  if (norm(oppTxt) === "bye") {
    return `Round ${idx + 1}: BYE — ${battleplan}`;
  }

  const result = findGameResult(player, oppTxt, battleplan);

  if (!result) {
    return `Round ${idx + 1}: ${oppTxt} — ${battleplan}`;
  }

  const p1 = getCol(result, ["Player 1", "P1"]);
  const p1vps = getCol(result, ["P1 VPs", "P1 VP", "Player 1 VPs"]);
  const p2vps = getCol(result, ["P2 VPs", "P2 VP", "Player 2 VPs"]);
  const status = getCol(result, ["Status", "status"]) || "Unplayed";

  const hasScore = String(p1vps).trim() !== "" && String(p2vps).trim() !== "";

  if (!hasScore) {
    return `Round ${idx + 1}: ${oppTxt} — ${battleplan} — ${status}`;
  }

  const score = sameName(player, p1) ? `${p1vps}-${p2vps}` : `${p2vps}-${p1vps}`;

  return `Round ${idx + 1}: ${oppTxt} — ${battleplan} — **${score}**`;
}

// ==================================================
// HISTORY
// ==================================================
function previousSeasonLines(player) {
  const rows = leagueHistoryCache.filter((r) =>
    sameName(getCol(r, ["Player", "player"]), player)
  );

  if (!rows.length) return [];

  return rows
    .sort((a, b) => {
      const sa = toNum(getCol(a, ["Season", "season"])) || 0;
      const sb = toNum(getCol(b, ["Season", "season"])) || 0;
      return sb - sa;
    })
    .map((r) => {
      const season = getCol(r, ["Season", "season"]);
      const league = getCol(r, ["League", "league"]);
      const position = getCol(r, ["Position", "position"]);
      const result = getCol(r, ["Result", "result"]);
      const vps = getCol(r, ["VPs", "VP", "vps"]);

      return `Season ${season}: **${position}** in ${league} — ${result}, ${vps} VPs`;
    });
}

// ==================================================
// LEAGUE TABLE
// ==================================================
function buildLeagueTableRows(leagueName) {
  const q = norm(leagueName);

  const rows = leaguePlayersCache
    .filter((r) => {
      const league = lpLeague(r);
      if (!league) return false;
      return norm(league) === q || startsOrIncludes(league, leagueName);
    })
    .map((r) => ({
      player: String(lpPlayer(r) ?? "").trim(),
      w: Math.round(lpW(r) || 0),
      d: Math.round(lpD(r) || 0),
      l: Math.round(lpL(r) || 0),
      pts: Math.round(lpPts(r) || 0),
    }))
    .filter((x) => x.player);

  rows.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.w !== a.w) return b.w - a.w;

    const aGames = a.w + a.d + a.l;
    const bGames = b.w + b.d + b.l;

    if (bGames !== aGames) return bGames - aGames;

    return a.player.localeCompare(b.player);
  });

  return rows;
}

// ==================================================
// DISCORD CLIENT
// ==================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("league")
      .setDescription("Show a player's army list, fixtures, results, and history")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Player name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("table")
      .setDescription("Show the league standings table")
      .addStringOption((o) =>
        o
          .setName("league")
          .setDescription("League name")
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Admin: refresh cached league CSVs")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());

  await client.application.commands.set(commands);
  console.log("Global slash commands registered/updated.");

  try {
    await loadLeaguePlayers(true);
    console.log("League players cache warmed.");
  } catch (e) {
    console.warn("League players cache warm failed:", e?.message ?? e);
  }

  try {
    await loadLeagueResults(true);
    console.log("League results cache warmed.");
  } catch (e) {
    console.warn("League results cache warm failed:", e?.message ?? e);
  }

  try {
    await loadLeagueHistory(true);
    console.log("League history cache warmed.");
  } catch (e) {
    console.warn("League history cache warm failed:", e?.message ?? e);
  }
});

// ==================================================
// AUTOCOMPLETE
// ==================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  try {
    await ensureLeaguePlayers();

    const focused = interaction.options.getFocused(true);
    const typed = String(focused?.value ?? "");

    if (interaction.commandName === "league" && focused.name === "name") {
      return interaction.respond(makeChoices(getLeaguePlayers(), typed));
    }

    if (interaction.commandName === "table" && focused.name === "league") {
      return interaction.respond(makeChoices(getLeagues(), typed));
    }

    return interaction.respond([]);
  } catch (e) {
    console.error("AUTOCOMPLETE ERROR:", e);

    try {
      return interaction.respond([]);
    } catch {}
  }
});

// ==================================================
// COMMANDS
// ==================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply();
  } catch {}

  try {
    const cmd = interaction.commandName;

    // ----------------------------------------------
    // /refresh
    // ----------------------------------------------
    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        const embed = makeBaseEmbed("Admin Only").setDescription(
          "You need Administrator permission to run `/refresh`."
        );

        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const results = [];

      try {
        await loadLeaguePlayers(true);
        results.push("Players: refreshed");
      } catch (e) {
        results.push("Players: failed");
        console.warn("Players refresh failed:", e?.message ?? e);
      }

      try {
        await loadLeagueResults(true);
        results.push("Results: refreshed");
      } catch (e) {
        results.push("Results: failed");
        console.warn("Results refresh failed:", e?.message ?? e);
      }

      try {
        await loadLeagueHistory(true);
        results.push("History: refreshed");
      } catch (e) {
        results.push("History: failed");
        console.warn("History refresh failed:", e?.message ?? e);
      }

      const embed = makeBaseEmbed("Refresh Results").setDescription(results.join("\n"));

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ----------------------------------------------
    // /league
    // ----------------------------------------------
    if (cmd === "league") {
      await ensureAllLeagueData();

      const input = interaction.options.getString("name");
      const q = norm(input);

      const row =
        leaguePlayersCache.find((r) => norm(lpPlayer(r)) === q) ||
        leaguePlayersCache.find((r) => norm(lpPlayer(r)).includes(q));

      if (!row) {
        const embed = makeBaseEmbed("No Results").setDescription(
          `No league player found for "${input}".`
        );

        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const playerName = lpPlayer(row);
      const leagueName = lpLeague(row);

      const embed = makeBaseEmbed(`Player Profile — ${playerName}`);

      if (leagueName) {
        embed.setDescription(`League: **${leagueName}**`);
      }

      // Army list
      const listText = String(lpList(row) ?? "").trim();

      if (!listText) {
        embed.addFields({ name: "Army List", value: "No list submitted." });
      } else {
        const listChunks = chunkText(listText, 1024);

        listChunks.slice(0, 6).forEach((chunk, idx) => {
          embed.addFields({
            name: idx === 0 ? "Army List" : "Army List (cont.)",
            value: chunk,
          });
        });

        if (listChunks.length > 6) {
          embed.addFields({
            name: "Army List (truncated)",
            value: `List is long — showing first ${6 * 1024} characters.`,
          });
        }
      }

      // Fixtures with live results
      const opps = lpOpponents(row);

      const fixtureLines = opps.map((o, i) => {
        const bp = LEAGUE_BATTLEPLANS[i] ?? "—";
        return formatFixtureLine(playerName, o, bp, i);
      });

      embed.addFields({
        name: "Fixtures",
        value: fixtureLines.length ? fixtureLines.join("\n") : "No fixtures available.",
      });

      // Record
      const w = Math.round(lpW(row) || 0);
      const d = Math.round(lpD(row) || 0);
      const l = Math.round(lpL(row) || 0);
      const pts = Math.round(lpPts(row) || 0);

      embed.addFields({
        name: "Record",
        value: `**${w}-${d}-${l}**\nPoints: **${pts}**`,
        inline: true,
      });

      // Previous seasons
      const historyLines = previousSeasonLines(playerName);

      embed.addFields({
        name: "Previous Seasons",
        value: historyLines.length ? historyLines.join("\n") : "No previous season record found.",
      });

      // Deadline
      embed.addFields({
        name: "Deadline",
        value: deadlineLines().join("\n"),
      });

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    // ----------------------------------------------
    // /table
    // ----------------------------------------------
    if (cmd === "table") {
      await ensureLeaguePlayers();

      const leagueInput = interaction.options.getString("league");
      const leagues = getLeagues();
      const leagueDisplay = leagues.find((x) => norm(x) === norm(leagueInput)) ?? leagueInput;

      const tableRows = buildLeagueTableRows(leagueDisplay);

      if (!tableRows.length) {
        const embed = makeBaseEmbed("No Results").setDescription(
          `No players found for league "${leagueInput}".`
        );

        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const leader = tableRows[0];

      const embed = makeBaseEmbed(`League Table — ${leagueDisplay}`).setDescription(
        [
          leader
            ? `Leader: **${leader.player}** — **${leader.pts} pts** (${leader.w}-${leader.d}-${leader.l})`
            : null,
          "Sorted by **Pts**, then **Wins**, then **Games**.",
        ]
          .filter(Boolean)
          .join("\n")
      );

      const MAX_ROWS_PER_BLOCK = 25;
      const blocks = [];

      for (let i = 0; i < tableRows.length; i += MAX_ROWS_PER_BLOCK) {
        blocks.push(renderStandingsBlock(tableRows.slice(i, i + MAX_ROWS_PER_BLOCK)));
      }

      blocks.slice(0, 4).forEach((block, idx) => {
        embed.addFields({
          name: blocks.length > 1 ? `Standings ${idx + 1}/${blocks.length}` : "Standings",
          value: block,
        });
      });

      if (blocks.length > 4) {
        embed.addFields({
          name: "Standings truncated",
          value: "Too many players to show in one embed.",
        });
      }

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    const embed = makeBaseEmbed("Unknown Command").setDescription("Try `/league` or `/table`.");
    leagueCachedFooter(embed);
    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("COMMAND ERROR:", err);

    const embed = makeBaseEmbed("Internal Error").setDescription(
      `Check logs.\n\nError: ${String(err?.message ?? err)}`
    );

    leagueCachedFooter(embed);

    try {
      return interaction.editReply({ embeds: [embed] });
    } catch {
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.login(TOKEN);
