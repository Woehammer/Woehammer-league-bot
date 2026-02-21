// index.js
// Discord.js v14 single-file bot (ESM) — LEAGUE ONLY
//
// Env vars required:
//   DISCORD_TOKEN
//   LEAGUE_PLAYERS_CSV_URL   (published Google Sheet CSV link)
//
// Commands:
//   /league name:<player>    -> list + fixtures + results (+ battleplans)
//   /table league:<league>   -> league table (standings)
//   /refresh                 -> admin refresh of league CSV
//
// Notes:
// - Soft-fail fetching: if Google 401s but cache exists, bot still works.
// - Autocomplete for player names and league names.
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

function chunkByLines(lines, maxLen = 1024) {
  const chunks = [];
  let cur = "";

  for (const line of lines) {
    const add = (cur ? "\n" : "") + line;
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      if (line.length > maxLen) {
        chunkText(line, maxLen).forEach((c) => chunks.push(c));
        cur = "";
      } else {
        cur = line;
      }
    } else {
      cur += add;
    }
  }

  if (cur) chunks.push(cur);
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
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
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
  if (!LEAGUE_PLAYERS_CSV_URL)
    throw new Error("Missing LEAGUE_PLAYERS_CSV_URL env var");
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
const lpList   = (r) => getCol(r, ["Lists", "List", "lists", "list"]);

const lpOpponents = (r) => ([
  getCol(r, ["Rnd 1 Opponent", "Round 1 Opponent", "R1 Opponent"]),
  getCol(r, ["Rnd 2 Opponent", "Round 2 Opponent", "R2 Opponent"]),
  getCol(r, ["Rnd 3 Opponent", "Round 3 Opponent", "R3 Opponent"]),
  getCol(r, ["Rnd 4 Opponent", "Round 4 Opponent", "R4 Opponent"]),
  getCol(r, ["Rnd 5 Opponent", "Round 5 Opponent", "R5 Opponent"]),
]);

const lpGames = (r) => toNum(getCol(r, ["Games", "games", "Played"]));
const lpW     = (r) => toNum(getCol(r, ["W", "w", "Wins"]));
const lpD     = (r) => toNum(getCol(r, ["D", "d", "Draws"]));
const lpL     = (r) => toNum(getCol(r, ["L", "l", "Losses"]));
const lpPts   = (r) => toNum(getCol(r, ["Pts", "pts", "Points"]));

function getLeaguePlayers() {
  const names = leaguePlayersCache
    .map((r) => lpPlayer(r))
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return uniq(names);
}

function getLeagues() {
  const leagues = leaguePlayersCache
    .map((r) => lpLeague(r))
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return uniq(leagues);
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

// -------------------- LEAGUE TABLE HELPERS --------------------
function buildLeagueTableRows(leagueInput) {
  const target = norm(leagueInput);

  const rows = leaguePlayersCache
    .filter((r) => norm(lpLeague(r)) === target)
    .map((r) => {
      const player = String(lpPlayer(r) ?? "").trim() || "Unknown";
      const played = lpGames(r);
      const w = lpW(r);
      const d = lpD(r);
      const l = lpL(r);
      const pts = lpPts(r);

      return {
        player,
        played: Number.isFinite(played) ? played : 0,
        w: Number.isFinite(w) ? w : 0,
        d: Number.isFinite(d) ? d : 0,
        l: Number.isFinite(l) ? l : 0,
        pts: Number.isFinite(pts) ? pts : 0,
      };
    });

  // Sort: Pts desc, then W desc, then Played asc
  rows.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (b.w !== a.w) return b.w - a.w;
    return a.played - b.played;
  });

  return rows;
}

function formatLeagueTableLines(rows, limit = 50) {
  const slice = rows.slice(0, limit);

  return slice.map((r, i) => {
    const pos = String(i + 1).padStart(2, "0");
    return `**${pos}. ${r.player}** — Pts **${r.pts}** | ${r.played}P ${r.w}-${r.d}-${r.l}`;
  });
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
      .setDescription("Show the league table (standings) for a league")
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
  console.log("✅ Global slash commands registered/updated.");

  // Warm cache (don’t die if it fails)
  if (LEAGUE_PLAYERS_CSV_URL) {
    try {
      await loadLeaguePlayers(true);
      console.log("✅ League cache warmed.");
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

    if (cmd === "league" && focused.name === "name") {
      try { await ensureLeaguePlayers(); } catch {}
      const choices = makeChoices(getLeaguePlayers(), typed);
      return interaction.respond(choices.slice(0, 25));
    }

    if (cmd === "table" && focused.name === "league") {
      try { await ensureLeaguePlayers(); } catch {}
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
        const embed = makeBaseEmbed("❌ Admin only")
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

      const embed = makeBaseEmbed("🔄 Refresh results").setDescription(
        ok === null
          ? "League: — (LEAGUE_PLAYERS_CSV_URL not set)"
          : `League: ${ok ? "✅ refreshed" : "⚠️ refresh failed (using cached)"}`
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

      // Army list (embed fields max 1024 chars)
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

      // Fixtures + Battleplans
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

      // Results
      embed.addFields({
        name: "Results",
        value: [
          `Played: **${fmtInt(lpGames(row))}**`,
          `Won: **${fmtInt(lpW(row))}**`,
          `Drew: **${fmtInt(lpD(row))}**`,
          `Lost: **${fmtInt(lpL(row))}**`,
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
      const leagueDisplay =
        leagues.find((x) => norm(x) === norm(leagueInput)) ?? leagueInput;

      const tableRows = buildLeagueTableRows(leagueDisplay);

      if (!tableRows.length) {
        const embed = makeBaseEmbed("No results").setDescription(
          `No players found for league "${leagueInput}".`
        );
        leagueCachedFooter(embed);
        return interaction.editReply({ embeds: [embed] });
      }

      const embed = makeBaseEmbed(`League Table — ${leagueDisplay}`);
      embed.setDescription(
        `Sorted by **Pts**, then **Wins**, then **Games Played**.\n(Proper tie-breakers need scorelines / VP.)`
      );

      const lines = formatLeagueTableLines(tableRows, 50);
      const chunks = chunkByLines(lines, 1024);

      chunks.forEach((chunk, idx) => {
        embed.addFields({
          name: idx === 0 ? "Standings" : "Standings (cont.)",
          value: chunk,
        });
      });

      leagueCachedFooter(embed);
      return interaction.editReply({ embeds: [embed] });
    }

    const embed = makeBaseEmbed("❌ Unknown command").setDescription("Try `/league` or `/table`.");
    leagueCachedFooter(embed);
    return interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error("COMMAND ERROR:", err);

    const embed = makeBaseEmbed("❌ Internal error").setDescription(
      `Check logs.\n\n**Error:** ${String(err?.message ?? err)}`
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