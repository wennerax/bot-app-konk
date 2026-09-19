import pg from 'pg';

const { Pool } = pg;

const schema = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  username TEXT,
  url TEXT,
  required_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  mini_app_button_color TEXT NOT NULL DEFAULT '#e6ff54',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS giveaways (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  required_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  mini_app_button_color TEXT NOT NULL DEFAULT '#e6ff54',
  media JSONB,
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  winners_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winners JSONB NOT NULL DEFAULT '[]'::jsonb,
  participant_profiles JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS participants (
  giveaway_id TEXT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE INDEX IF NOT EXISTS participants_user_idx ON participants(user_id);
`;

function mapChannel(row) {
  return {
    id: row.id,
    title: row.title,
    username: row.username,
    url: row.url,
    requiredChannels: row.required_channels,
    miniAppButtonColor: row.mini_app_button_color
  };
}

function mapGiveaway(row, participantRows) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sourceText: row.source_text,
    channelId: row.channel_id,
    requiredChannels: row.required_channels,
    miniAppButtonColor: row.mini_app_button_color,
    media: row.media,
    entities: row.entities,
    winnersCount: row.winners_count,
    status: row.status,
    participants: participantRows.map((participant) => participant.user_id),
      participantProfiles: row.participant_profiles ?? {},
    winners: row.winners,
    createdAt: new Date(row.created_at).toISOString(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null
  };
}

export async function createPostgresStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
  await pool.query(schema);
  await pool.query("ALTER TABLE giveaways ADD COLUMN IF NOT EXISTS participant_profiles JSONB NOT NULL DEFAULT '{}'::jsonb");

  async function loadGiveaway(id) {
    const result = await pool.query('SELECT * FROM giveaways WHERE id = $1', [id]);
    if (!result.rows[0]) return null;
    const participants = await pool.query('SELECT user_id FROM participants WHERE giveaway_id = $1 ORDER BY joined_at', [id]);
    return mapGiveaway(result.rows[0], participants.rows);
  }

  return {
    async saveGiveaway(giveaway) {
      await pool.query(`
        INSERT INTO giveaways (id, title, description, source_text, channel_id, required_channels, mini_app_button_color, media, entities, winners_count, status, winners, participant_profiles, created_at, ends_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14,$15)
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description, source_text=EXCLUDED.source_text, channel_id=EXCLUDED.channel_id, required_channels=EXCLUDED.required_channels, mini_app_button_color=EXCLUDED.mini_app_button_color, media=EXCLUDED.media, entities=EXCLUDED.entities, winners_count=EXCLUDED.winners_count, status=EXCLUDED.status, winners=EXCLUDED.winners, participant_profiles=EXCLUDED.participant_profiles, ends_at=EXCLUDED.ends_at
      `, [giveaway.id, giveaway.title, giveaway.description, giveaway.sourceText ?? '', giveaway.channelId, JSON.stringify(giveaway.requiredChannels), giveaway.miniAppButtonColor, JSON.stringify(giveaway.media), JSON.stringify(giveaway.entities), giveaway.winnersCount, giveaway.status, JSON.stringify(giveaway.winners), JSON.stringify(giveaway.participantProfiles ?? {}), giveaway.createdAt, giveaway.endsAt]);
      await pool.query('DELETE FROM participants WHERE giveaway_id = $1', [giveaway.id]);
      if (giveaway.participants.length) {
        await pool.query(`INSERT INTO participants (giveaway_id, user_id) SELECT $1, UNNEST($2::text[]) ON CONFLICT DO NOTHING`, [giveaway.id, giveaway.participants]);
      }
      return giveaway;
    },
    getGiveaway: loadGiveaway,
    async listGiveaways() {
      const result = await pool.query('SELECT * FROM giveaways ORDER BY created_at DESC');
      const participants = await pool.query('SELECT giveaway_id, user_id FROM participants ORDER BY joined_at');
      return result.rows.map((row) => mapGiveaway(row, participants.rows.filter((item) => item.giveaway_id === row.id)));
    },
    async saveChannel(channel) {
      const result = await pool.query(`
        INSERT INTO channels (id, title, username, url, required_channels, mini_app_button_color)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, username=EXCLUDED.username, url=EXCLUDED.url, required_channels=EXCLUDED.required_channels, mini_app_button_color=EXCLUDED.mini_app_button_color, updated_at=NOW()
        RETURNING *
      `, [String(channel.id), channel.title ?? 'Без названия', channel.username ?? null, channel.url ?? null, JSON.stringify(channel.requiredChannels ?? []), channel.miniAppButtonColor ?? '#e6ff54']);
      return mapChannel(result.rows[0]);
    },
    async listChannels() {
      const result = await pool.query('SELECT * FROM channels ORDER BY title');
      return result.rows.map(mapChannel);
    },
    async getChannel(id) {
      const result = await pool.query('SELECT * FROM channels WHERE id = $1', [String(id)]);
      return result.rows[0] ? mapChannel(result.rows[0]) : null;
    },
    async close() {
      await pool.end();
    }
  };
}
