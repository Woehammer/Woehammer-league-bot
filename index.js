// index.js
// Discord.js v14 single-file bot (ESM) — LEAGUE ONLY
//
// Env vars required:
//   DISCORD_TOKEN
//   LEAGUE_PLAYERS_CSV_URL   (published Google Sheet CSV link)
//
// Commands:
//   /league name:<player>   -> list + fixtures + results (+ battleplans)
//   /table league:<league>  -> league standings table (clean esports style)
//   /refresh                -> admin refresh of league CSV
//
// Notes:
// - Soft-fail fetching: if Google 401s but cache exists, bot still works.
// - Autocomplete for player names and leagues.
// - Healthcheck server for hosting platforms.

import http from "http";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  Events,
  EmbedBuilder,
} from "discord.js";

// -------------------- ENV --------------------
const TOKEN = process.env.DISCORD_TOKEN;
const LEAGUE_PLAYERS_CSV_URL = process.env.LEAGUE_PLAYERS_CSV_URL;

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var");
if (!LEAGUE_PLAYERS_CSV_URL)
  console.warn("⚠️ Missing LEAGUE_PLAYERS_CSV_URL env var (/league and /table will fail).");

console.log("LEAGUE_PLAYERS_CSV_URL =", LEAGUE_PLAYERS_CSV_URL);

// -------------------- HEALTHCHECK --------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(PORT, () => console.log(`Healthcheck server listening on ${PORT}`));

// -------------------- LEAGUE CONSTANTS --------------------
const LEAGUE_BATTLEPLANS = [
  "Paths of the Fey",
  "The Liferoots",
  "Surge of Slaughter",
  "Lifecycle",
  "Roiling Roots",
];

// -------------------- CSV parsing (handles quotes reasonably) --------------------
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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
  const data = rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? "";
    return obj;
  });

  return data;
}

// -------------------- HELPERS --------------------
function norm(s) {
  return String(s ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function toNum(x) {
  const s = String(x ?? "").trim();
  if (!s) return NaN;
  const cleaned = s.replace(/%/g, "").replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function fmtInt(x) {
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x)}`;
}

function nowStr(d = new Date()) {
  return d.toLocaleString("en-GB", { hour12: true });
}

function makeBaseEmbed(title) {
  return new EmbedBuilder().setTitle(title).setFooter({ text: "Woehammer League" });
}

function leagueCachedFooter(embed) {
  const cached = leaguePlayersCachedAt ? nowStr(leaguePlayersCachedAt) : "—";
  const base = embed.data?.footer?.text || "Woehammer League";
  embed.setFooter({ text: `${base} • Cached: ${cached}` });
  return embed;
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function startsOrIncludes(haystack, needle) {
  const h = norm(haystack);
  const n = norm(needle);
  if (!n) return true;
  return h.startsWith(n) || h.includes(n);
}

function getCol(row, candidates) {
  for (const c of candidates) {
    if (c in row) return row[c];
  }
  return "";
}

// -------------------- CLEAN TABLE RENDERING (NO EMOJIS) --------------------
// NOTE: Markdown bold does NOT work inside ``` code blocks.
// We'll keep the aligned table in a code block, and put bold points in a "Top" line above it.
function clampName(name, max = 20) {
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
  const REC_W = 5; // "W-D-L" like "3-0-2"

  const header =
    `${padR("Player", NAME_W)} ${padL("P", 2)} ${padR("W-D-L", REC_W)} ${padL("Pts", 3)}`;
  const rule = "-".repeat(header.length);

  const lines = rows.map((r) => {
    const name = clampName(r.player, NAME_W);
    const rec = `${r.w}-${r.d}-${r.l}`;
    return `${padR(name, NAME_W)} ${padL(r.played, 2)} ${padR(rec, REC_W)} ${padL(r.pts, 3)}`;
  });

  return ["```", header, rule, ...lines, "```"].join("\n");
}

// -------------------- LEAGUE CACHE + FETCH --------------------
let leaguePlayersCache = [];
let leaguePlayersCachedAt = null;

function withCacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}cb=${Date.now()}`;
}

async function fetchCSV(url, { cacheBust = false } = {}) {
  const finalUrl = cacheBust ? withCacheBust(url) : url;

  const res = await fetch(finalUrl, {
    headers: { "User-Agent": "WoehammerLeagueBot/1.0" },
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
  if (!LEAGUE_PLAYERS_CSV_URL) throw new Error("Missing LEAGUE_PLAYERS_CSV_URL env var");
  if (!force && leaguePlayersCache.length) return;

  leaguePlayersCache = await fetchCSV(LEAGUE_PLAYERS_CSV_URL, { cacheBust: force });
  leaguePlayersCachedAt = new Date();
}

async function ensureLeaguePlayers() {
  try {
    await loadLeaguePlayers(false);
  } catch (e) {
    if (!leaguePlayersCache.length) throw e;
    console.warn("League fetch failed; using cached:", e?.message ?? e);
  }
}

// -------------------- LEAGUE CSV COLUMN HELPERS --------------------
const lpPlayer = (r) => getCol(r, ["Player", "player", "Name", "name"]);
const lpLeague = (r) => getCol(r, ["League", "league"]);
const lpList = (r) => getCol(r, ["Lists", "List", "lists", "list"]);

const lpOpponents = (r) => ([
  getCol(r, ["Rnd 1 Opponent", "Round 1 Opponent", "R1 Opponent"]),
  getCol(r, ["Rnd 2 Opponent", "Round 2 Opponent", "R2 Opponent"]),
  getCol(r, ["Rnd 3 Opponent", "Round 3 Opponent", "R3 Opponent"]),
  getCol(r, ["Rnd 4 Opponent", "Round 4 Opponent", "R4 Opponent"]),
  getCol(r, ["Rnd 5 Opponent", "Round 5 Opponent", "R5 Opponent"]),
]);

const lpGames = (r) => toNum(getCol(r, ["Games", "games", "Played"]));
const lpW = (r) => toNum(getCol(r, ["W", "w", "Wins"]));
const lpD = (r) => toNum(getCol(r, ["D", "d", "Draws"]));
const lpL = (r) => toNum(getCol(r, ["L", "l", "Losses"]));
const lpPts = (r) => toNum(getCol(r, ["Pts", "pts", "Points"]));

// -------------------- AUTOCOMPLETE LISTS --------------------
function getLeaguePlayers() {
  const names = leaguePlayersCache
    .map((r) => lpPlayer(r))
    .map((x) => String(x ?? "").trim());
  return uniq(names);
}

function getLeagues() {
  const leagues = leaguePlayersCache
    .map((r) => lpLeague(r))
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return uniq(leagues).sort((a, b) => a.localeCompare(b));
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

// -------------------- LEAGUE TABLE BUILD --------------------
function buildLeagueTableRows(leagueName) {
  const q = norm(leagueName);

  const rows = leaguePlayersCache
    .filter((r) => norm(lpLeague(r)) === q)
    .map((r) => ({
      player: String(lpPlayer(r) ?? "").trim(),
      played: Math.round(toNum(lpGames(r)) || 0),
      w: Math.round(toNum(lpW(r)) || 0),
      d: Math.round(toNum(lpD(r)) || 0),
      l: Math.round(toNum(lpL(r)) || 0),
      pts: Math.round(toNum(lpPts(r)) || 0),
    }))
    .filter((x) => x.player);

  // Sort: Pts desc, Wins desc, Played desc, Name asc
  rows.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.w !== a.w) return b.w - a.w;
    if (b.played !== a.played) return b.played - a.played;
    return a.player.localeCompare(b.player);
  });

  return rows;
}

// -------------------- DISCORD CLIENT --------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("league")
      .setDescription("Show a player's army list, fixtures, and results")
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
      .setDescription("Admin: refresh cached league CSV")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map((c) => c.toJSON());

  await client.application.commands.set(commands);
  console.log("Global slash commands registered/updated.");

  // Warm cache (don’t die if it fails)
  if (LEAGUE_PLAYERS_CSV_URL) {
    try {
      await loadLeaguePlayers(true);
      console.log("League cache warmed.");
    } catch (e) {
      console.warn("League cache warm failed:", e?.message ?? e);
    }
  }
});

// -------------------- AUTOCOMPLETE --------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  try {
    const cmd = interaction.commandName;
    const focused = interaction.options.getFocused(true);
    const typed = String(focused?.value ?? "");

    if (cmd === "league" || cmd === "table") {
      try { await ensureLeaguePlayers(); } catch {}
    }

    if (cmd === "league" && focused.name === "name") {
      const choices = makeChoices(getLeaguePlayers(), typed);
      return interaction.respond(choices.slice(0, 25));
    }

    if (cmd === "table" && focused.name === "league") {
      const choices = makeChoices(getLeagues(), typed);
      return interaction.respond(choices.slice(0, 25));
    }

    return interaction.respond([]);
  } catch {
    try { return interaction.respond([]); } catch {}
  }
});

// -------------------- COMMANDS --------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try { await interaction.deferReply(); } catch {}

  try {
    const cmd = interaction.commandName;

    if (cmd === "refresh") {
      if (!isAdmin(interaction)) {
        const embed = makeBaseEmbed("Admin only")
          .setDescription("You need Administrator permission to run `/refresh`.");
        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      let ok = null;
      try {
        await loadLeaguePlayers(true);
        ok = true;
      } catch (e) {
        ok = false;
        console.warn("League refresh failed; keeping cache:", e?.message ?? e);
      }

      const embed = makeBaseEmbed("Refresh results").setDescription(
        ok === null
          ? "League: (LEAGUE_PLAYERS_CSV_URL not set)"
          : `League: ${ok ? "refreshed" : "refresh failed (using cached)"}`
      );

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "league") {
      await ensureLeaguePlayers();

      const input = interaction.options.getString("name");
      const q = norm(input);

      const row = leaguePlayersCache.find((r) => norm(lpPlayer(r)).includes(q));

      if (!row) {
        const embed = makeBaseEmbed("No results")
          .setDescription(`No league player found for "${input}".`);
        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const playerName = lpPlayer(row);
      const leagueName = lpLeague(row);

      const embed = makeBaseEmbed(`Player Profile — ${playerName}`);
      if (leagueName) embed.setDescription(`League: **${leagueName}**`);

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

      const opps = lpOpponents(row);
      const fixtureLines = opps.map((o, i) => {
        const bp = LEAGUE_BATTLEPLANS[i] ?? "—";
        const oppTxt = o ? o : "—";
        return `Round ${i + 1}: ${oppTxt} — **${bp}**`;
      });

      embed.addFields({
        name: "Fixtures & Battleplans",
        value: fixtureLines.length ? fixtureLines.join("\n") : "No fixtures available.",
      });

      embed.addFields({
        name: "Results",
        value: [
          `Played: **${fmtInt(lpGames(row))}**`,
          `Record: **${fmtInt(lpW(row))}-${fmtInt(lpD(row))}-${fmtInt(lpL(row))}**`,
          `Points: **${fmtInt(lpPts(row))}**`,
        ].join("\n"),
        inline: true,
      });

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    if (cmd === "table") {
      await ensureLeaguePlayers();

      const leagueInput = interaction.options.getString("league");
      const leagues = getLeagues();
      const leagueExact = leagues.find((x) => norm(x) === norm(leagueInput));

      if (!leagueExact) {
        const embed = makeBaseEmbed("No results").setDescription(
          `Unknown league "${leagueInput}".`
        );
        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const tableRows = buildLeagueTableRows(leagueExact);

      if (!tableRows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No players found for league "${leagueExact}".`
        );
        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const leader = tableRows[0];
      const embed = makeBaseEmbed(`League Table — ${leagueExact}`);

      // Bold points here (works), keep the aligned block below
      embed.setDescription(
        `Leader: **${leader.player}** — **${leader.pts} pts** (${leader.w}-${leader.d}-${leader.l})\n` +
        `Sorted by Pts, then Wins, then Games Played.`
      );

      const MAX_ROWS_PER_BLOCK = 25;
      const blocks = [];
      for (let i = 0; i < tableRows.length; i += MAX_ROWS_PER_BLOCK) {
        blocks.push(renderStandingsBlock(tableRows.slice(i, i + MAX_ROWS_PER_BLOCK)));
      }

      blocks.slice(0, 4).forEach((block, idx) => {
        embed.addFields({
          name: blocks.length > 1 ? `Standings (Page ${idx + 1}/${blocks.length})` : "Standings",
          value: block,
        });
      });

      if (blocks.length > 4) {
        embed.addFields({
          name: "Standings (truncated)",
          value: "Too many players to show in one embed.",
        });
      }

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    const embed = makeBaseEmbed("Unknown command").setDescription("Try `/league` or `/table`.");
    leagueCachedFooter(embed);
    return interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error("COMMAND ERROR:", err);

    const embed = makeBaseEmbed("Internal error").setDescription(
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