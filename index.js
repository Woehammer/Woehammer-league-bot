// index.js
// Discord.js v14 — LEAGUE BOT (Season 2 Upgrade)
//
// NEW FEATURES:
// - Live match results shown in /league fixtures
// - Previous season history shown in player profile
//

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

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN");

// ==================================================
// HEALTHCHECK
// ==================================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT);

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
        rows.push(row);
        row = [];
      }
      continue;
    }

    field += c;
  }

  row.push(field);
  rows.push(row);

  const headers = rows[0];
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
}

// ==================================================
// HELPERS
// ==================================================
const norm = (s) => String(s ?? "").toLowerCase().trim();

const getCol = (row, keys) => {
  for (const k of keys) if (k in row) return row[k];
  return "";
};

const toNum = (x) => Number(String(x ?? "").replace(/[^0-9.-]/g, "")) || 0;

function deadlineLines() {
  const t = Math.floor(LEAGUE_DEADLINE.getTime() / 1000);
  return [
    `You have until <t:${t}:F> to arrange and play your games.`,
    `This leaves you <t:${t}:R>.`
  ];
}

// ==================================================
// CACHE
// ==================================================
let players = [];
let results = [];
let history = [];

async function fetchCSV(url) {
  const res = await fetch(url + "&cb=" + Date.now());
  const text = await res.text();
  return parseCSV(text);
}

async function loadAll(force = false) {
  if (!players.length || force) players = await fetchCSV(LEAGUE_PLAYERS_CSV_URL);
  if (!results.length || force) results = await fetchCSV(LEAGUE_RESULTS_CSV_URL);
  if (!history.length || force) history = await fetchCSV(LEAGUE_HISTORY_CSV_URL);
}

// ==================================================
// RESULTS MATCHING
// ==================================================
function findResult(player, opponent, battleplan) {
  return results.find(r => {
    const p1 = getCol(r, ["Player 1"]);
    const p2 = getCol(r, ["Player 2"]);
    const bp = getCol(r, ["Battleplan"]);

    return (
      ((norm(p1) === norm(player) && norm(p2) === norm(opponent)) ||
       (norm(p2) === norm(player) && norm(p1) === norm(opponent)))
      && norm(bp) === norm(battleplan)
    );
  });
}

function formatFixture(player, opponent, battleplan, i) {
  if (!opponent || norm(opponent) === "bye") {
    return `Round ${i+1}: BYE — ${battleplan}`;
  }

  const r = findResult(player, opponent, battleplan);

  if (!r) return `Round ${i+1}: ${opponent} — ${battleplan}`;

  const p1 = getCol(r, ["Player 1"]);
  const p1v = getCol(r, ["P1 VPs"]);
  const p2v = getCol(r, ["P2 VPs"]);

  if (!p1v || !p2v) return `Round ${i+1}: ${opponent} — ${battleplan}`;

  const score = norm(player) === norm(p1)
    ? `${p1v}-${p2v}`
    : `${p2v}-${p1v}`;

  return `Round ${i+1}: ${opponent} — ${battleplan} — **${score}**`;
}

// ==================================================
// HISTORY
// ==================================================
function getHistory(player) {
  return history
    .filter(r => norm(r.Player) === norm(player))
    .map(r =>
      `Season ${r.Season}: **${r.Position}** — ${r.Result} (${r.VPs} VPs)`
    );
}

// ==================================================
// DISCORD CLIENT
// ==================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log("Bot Ready");

  await loadAll(true);

  const commands = [
    new SlashCommandBuilder()
      .setName("league")
      .setDescription("Show player profile")
      .addStringOption(o =>
        o.setName("name").setRequired(true).setDescription("Player name")
      ),

    new SlashCommandBuilder()
      .setName("refresh")
      .setDescription("Refresh data")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ];

  await client.application.commands.set(commands);
});

// ==================================================
// COMMAND HANDLER
// ==================================================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply();

  if (interaction.commandName === "refresh") {
    await loadAll(true);
    return interaction.editReply("Data refreshed.");
  }

  if (interaction.commandName === "league") {
    await loadAll();

    const name = interaction.options.getString("name");

    const row = players.find(p => norm(p.Player).includes(norm(name)));

    if (!row) return interaction.editReply("Player not found.");

    const embed = new EmbedBuilder()
      .setTitle(row.Player)
      .setDescription(`League: ${row.League}`);

    // Fixtures with scores
    const opps = [
      row["Rnd 1 Opponent"],
      row["Rnd 2 Opponent"],
      row["Rnd 3 Opponent"],
      row["Rnd 4 Opponent"],
      row["Rnd 5 Opponent"],
    ];

    const fixtures = opps.map((o, i) =>
      formatFixture(row.Player, o, LEAGUE_BATTLEPLANS[i], i)
    );

    embed.addFields({
      name: "Fixtures",
      value: fixtures.join("\n"),
    });

    // Record
    embed.addFields({
      name: "Record",
      value: `${row.W}-${row.D}-${row.L} (${row.Pts} pts)`,
    });

    // History
    const hist = getHistory(row.Player);
    embed.addFields({
      name: "Previous Seasons",
      value: hist.length ? hist.join("\n") : "None",
    });

    // Deadline
    embed.addFields({
      name: "Deadline",
      value: deadlineLines().join("\n"),
    });

    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(TOKEN);
