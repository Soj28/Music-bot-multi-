require('dotenv').config({ quiet: true });

const express = require('express');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelType,
    PermissionsBitField
} = require('discord.js');

const { PlayerManager } = require('ziplayer');
const {
    YouTubePlugin,
    SoundCloudPlugin,
    SpotifyPlugin,
    AttachmentsPlugin
} = require('@ziplayer/plugin');

const { getVoiceConnection } = require('@discordjs/voice');


// ======================================================
// INSTANCE
// ======================================================

const instance = Number(process.env.SLAVE_INSTANCE || 1);

if (instance < 1 || instance > 5) {
    throw new Error('SLAVE_INSTANCE phải từ 1 đến 5');
}


// ======================================================
// CONFIG
// ======================================================

const token =
    process.env[`SLAVE_${instance}_TOKEN`] ||
    process.env.TOKEN;

const port =
    Number(
        process.env[`SLAVE_${instance}_PORT`] ||
        (4100 + instance)
    );

const slaveId = `slave${instance}`;
const slaveName = `Music ${instance}`;

const MASTER_API = process.env.MASTER_API_URL || 'http://127.0.0.1:4000';
const MASTER_SECRET = process.env.MASTER_API_SECRET;
const MASTER_REQUEST_TIMEOUT = 10000;


// ======================================================
// VALIDATE
// ======================================================

if (!token) {
    throw new Error(
        `Không tìm thấy SLAVE_${instance}_TOKEN`
    );
}

if (!MASTER_SECRET) {
    throw new Error(
        'Không tìm thấy MASTER_API_SECRET'
    );
}


// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});


// ======================================================
// STATE
//
// guildId -> {
//     channelId,
//     connection
// }
// ======================================================

const connections = new Map();
const textChannels = new Map();
const playerStates = new Map();
const volumes = new Map();
const loops = new Map();
const filterState = new Map();
const uiMessages = new Map();
const uiTimers = new Map();

const manager = new PlayerManager({
    plugins: [
        new YouTubePlugin(),
        new SoundCloudPlugin(),
        new SpotifyPlugin(),
        new AttachmentsPlugin({
            maxFileSize: 25 * 1024 * 1024
        })
    ],
    extractorTimeout: 30000,
    autoCleanup: true,
    cleanupInterval: 120000,
    enableSearchCache: true
});

function getPlayer(guildId) {
    try {
        return manager.get(guildId) || null;
    } catch {
        return null;
    }
}

async function ensurePlayer(guild, voiceChannel, textChannel) {
    let player = getPlayer(guild.id);

    if (!player || player.destroyed) {
        player = await manager.create(guild.id, {
            volume: volumes.get(guild.id) ?? 100,
            quality: 'high',
            leaveOnEnd: false,
            leaveOnEmpty: false,
            leaveTimeout: 100000,
            selfDeaf: true,
            selfMute: false,
            userdata: { channel: textChannel || null }
        });
    }

    player.userdata = player.userdata || {};

    if (textChannel) {
        player.userdata.channel = textChannel;
        textChannels.set(guild.id, textChannel);
        startUITimer(guild.id);
    }

    const currentVoiceChannelId = guild.members.me?.voice.channelId;
    if (
        !player.connection ||
        currentVoiceChannelId !== voiceChannel.id
    ) {
        try {
            player.connection?.disconnect?.();
        } catch {}
        await player.connect(voiceChannel);
    }

    await notifyMaster('/slave/status', {
        guildId: guild.id,
        channelId: voiceChannel.id
    });

    return player;
}


// ======================================================
// CALL MASTER
// ======================================================

async function notifyMaster(endpoint, body = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        MASTER_REQUEST_TIMEOUT
    );

    try {

        const response = await fetch(
            `${MASTER_API}${endpoint}`,
            {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                    'Authorization':
                        `Bearer ${MASTER_SECRET}`
                },

                body: JSON.stringify({
                    slaveId,
                    ...body
                }),
                signal: controller.signal
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

    } catch (error) {

        console.error(
            `[SLAVE ${instance}] Master error | ${error.message}`
        );
    } finally {
        clearTimeout(timeout);
    }
}


// ======================================================
// JOIN VOICE
// ======================================================

async function joinVoice(guildId, channelId) {

    const guild =
        client.guilds.cache.get(guildId);

    if (!guild) {
        throw new Error(
            'Slave không có mặt trong server này.'
        );
    }


    const channel =
        guild.channels.cache.get(channelId);

    if (!channel) {
        throw new Error(
            'Voice channel không tồn tại.'
        );
    }


    if (
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildStageVoice
    ) {
        throw new Error(
            'Channel không phải voice channel.'
        );
    }


    // --------------------------------------------------
    // PERMISSIONS
    // --------------------------------------------------

    const me = guild.members.me;

    if (!me) {
        throw new Error(
            'Không tìm thấy bot member.'
        );
    }


    const permissions =
        channel.permissionsFor(me);

    if (!permissions?.has(
        PermissionsBitField.Flags.Connect
    )) {
        throw new Error(
            'Bot thiếu quyền CONNECT.'
        );
    }


    if (!permissions?.has(
        PermissionsBitField.Flags.Speak
    )) {
        throw new Error(
            'Bot thiếu quyền SPEAK.'
        );
    }


    const player = await ensurePlayer(
        guild,
        channel,
        textChannels.get(guildId)
    );

    connections.set(guildId, {
        channelId: channel.id,
        player
    });


    // --------------------------------------------------
    // NOTIFY MASTER
    // --------------------------------------------------

    await notifyMaster(
        '/slave/status',
        {
            guildId,
            channelId: channel.id
        }
    );


    console.log(
        `[SLAVE ${instance}] JOIN | ${channel.name}`
    );


    return channel;
}


// ======================================================
// LEAVE VOICE
// ======================================================

async function leaveVoice(guildId) {
    const player = getPlayer(guildId);

    if (player) {
        try {
            await player.stop();
        } catch {}

        try {
            player.connection?.disconnect?.();
        } catch {}
    }

    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();

    const timer = uiTimers.get(guildId);
    if (timer) clearInterval(timer);
    uiTimers.delete(guildId);

    connections.delete(guildId);
    uiMessages.delete(guildId);
    textChannels.delete(guildId);
    playerStates.delete(guildId);
    volumes.delete(guildId);
    loops.delete(guildId);
    filterState.delete(guildId);

    console.log(
        `[SLAVE ${instance}] LEAVE | ${guildId}`
    );

    return true;
}


// ======================================================
// EXPRESS
// ======================================================

const app = express();

app.use(express.json());


// ======================================================
// AUTH
// ======================================================

function authenticate(req, res, next) {

    const auth =
        req.headers.authorization;

    const expected =
        `Bearer ${MASTER_SECRET}`;

    if (auth !== expected) {

        return res
            .status(401)
            .json({
                success: false,
                error: 'Unauthorized'
            });
    }

    next();
}

app.use(authenticate);


// ======================================================
// HEALTH
// ======================================================

app.get('/health', (req, res) => {

    res.json({
        success: true,
        slaveId,
        name: slaveName,
        online: client.isReady(),
        connections: connections.size
    });
});


// ======================================================
// API: JOIN
// ======================================================

app.post('/join', async (req, res) => {

    const {
        guildId,
        channelId
    } = req.body;


    if (!guildId || !channelId) {

        return res
            .status(400)
            .json({
                success: false,
                error: 'guildId và channelId là bắt buộc.'
            });
    }


    try {

        const channel =
            await joinVoice(
                guildId,
                channelId
            );


        res.json({
            success: true,
            slaveId,
            channelId: channel.id,
            channelName: channel.name
        });


    } catch (error) {

        console.error(
            `[SLAVE ${instance}] JOIN ERROR | ${error.message}`
        );

        res
            .status(500)
            .json({
                success: false,
                error: error.message
            });
    }
});


// ======================================================
// API: LEAVE
// ======================================================

app.post('/leave', async (req, res) => {

    const { guildId } = req.body;


    if (!guildId) {

        return res
            .status(400)
            .json({
                success: false,
                error: 'guildId là bắt buộc.'
            });
    }


    try {

        await leaveVoice(guildId);

        res.json({
            success: true
        });


    } catch (error) {

        console.error(
            `[SLAVE ${instance}] LEAVE ERROR | ${error.message}`
        );

        res
            .status(500)
            .json({
                success: false,
                error: error.message
            });
    }
});

function getTrackTitle(track) {
    return track?.title || track?.name || track?.metadata?.title || 'Không rõ tên';
}

function getQueueTracks(player) {
    const queue = player?.queue;
    if (!queue) return [];
    if (typeof queue.getTrack === 'function' && typeof queue.size === 'number') {
        return Array.from({ length: queue.size }, (_, index) => queue.getTrack(index)).filter(Boolean);
    }
    return queue.tracks || queue.items || [];
}

const FILTERS = {
    none: 'Không filter',
    bassboost: 'Bass Boost',
    trebleboost: 'Treble Boost',
    nightcore: 'Nightcore',
    lofi: 'Lo-Fi',
    vaporwave: 'Vaporwave',
    echo: 'Echo',
    reverb: 'Reverb',
    chorus: 'Chorus',
    karaoke: 'Karaoke',
    normalize: 'Normalize',
    compressor: 'Compressor',
    limiter: 'Limiter'
};

function buildFilterMenu(guildId) {
    const current = filterState.get(guildId) || 'none';
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`music:${instance}:filter`)
            .setPlaceholder('🎛️ Chọn Filter')
            .addOptions(Object.entries(FILTERS).map(([value, label]) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(label)
                    .setValue(value)
                    .setDefault(value === current)
            ))
    );
}

function getCurrentTrack(player) {
    return player?.queue?.currentTrack || player?.currentTrack || player?.current || null;
}

function getStatus(guildId) {
    const state = playerStates.get(guildId) || 'stopped';
    if (state === 'paused') return '⏸️ Tạm dừng';
    if (state === 'playing') return '▶️ Đang phát';
    return '⏹️ Đã dừng';
}

function buildPlayerEmbed(guildId) {
    const player = getPlayer(guildId);
    const track = getCurrentTrack(player);
    const queueSize = getQueueTracks(player).length;
    const embed = new EmbedBuilder()
        .setColor(0x2b6cb0)
        .setTitle(`🎵 ${slaveName} • Music Player`)
        .setTimestamp();

    if (!track) {
        return embed
            .setDescription('Không có bài hát đang phát.')
            .addFields(
                { name: 'Trạng thái', value: getStatus(guildId), inline: true },
                { name: 'Queue', value: `${queueSize} bài`, inline: true },
                { name: 'Volume', value: `${volumes.get(guildId) ?? 100}%`, inline: true }
            );
    }

    const url = track.url || track.uri || track.link || track.metadata?.url;
    const description = url
        ? `[${getTrackTitle(track)}](${url})`
        : `**${getTrackTitle(track)}**`;

    return embed
        .setDescription(description)
        .addFields(
            { name: 'Trạng thái', value: getStatus(guildId), inline: true },
            { name: 'Queue', value: `${queueSize} bài`, inline: true },
            { name: 'Volume', value: `${volumes.get(guildId) ?? 100}%`, inline: true },
            { name: 'Loop', value: loops.get(guildId) || 'off', inline: true },
            { name: 'Filter', value: FILTERS[filterState.get(guildId) || 'none'], inline: true }
        )
        .setFooter({ text: `Điều khiển bởi ${slaveName}` });
}

function buildPlayerButtons(guildId) {
    const paused = playerStates.get(guildId) === 'paused';
    const loop = loops.get(guildId) === 'queue';
    const prefix = `music:${instance}:`;

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}pause`)
            .setLabel(paused ? 'Resume' : 'Pause')
            .setEmoji(paused ? '▶️' : '⏸️')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`${prefix}skip`)
            .setLabel('Skip')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}stop`)
            .setLabel('Stop')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`${prefix}shuffle`)
            .setLabel('Shuffle')
            .setEmoji('🔀')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${prefix}loop`)
            .setLabel(loop ? 'Loop ON' : 'Loop')
            .setEmoji('🔁')
            .setStyle(loop ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
}

async function sendOrUpdateUI(guildId, channel) {
    const target = channel || textChannels.get(guildId);
    if (!target) return null;

    const data = {
        embeds: [buildPlayerEmbed(guildId)],
        components: [buildPlayerButtons(guildId), buildFilterMenu(guildId)]
    };
    const oldMessage = uiMessages.get(guildId);

    if (oldMessage) {
        try {
            await oldMessage.edit(data);
            return oldMessage;
        } catch {
            uiMessages.delete(guildId);
        }
    }

    try {
        const message = await target.send(data);
        uiMessages.set(guildId, message);
        textChannels.set(guildId, target);
        return message;
    } catch (error) {
        console.error('[UI SEND ERROR]', error.message);
        return null;
    }
}

function startUITimer(guildId) {
    if (uiTimers.has(guildId)) return;
    const timer = setInterval(() => {
        if (playerStates.get(guildId) === 'playing' || playerStates.get(guildId) === 'paused') {
            sendOrUpdateUI(guildId).catch(error => console.error('[UI TIMER ERROR]', error.message));
        }
    }, 5000);
    uiTimers.set(guildId, timer);
}

async function runMusicCommand(command, context, args = []) {
    const guild = context.guild;
    const voiceChannel = context.member?.voice?.channel;
    const isInteraction = typeof context.deferReply === 'function';
    const respond = payload => isInteraction
        ? context.editReply(payload)
        : context.reply(payload);

    if (isInteraction) await context.deferReply({ ephemeral: true });
    if (!voiceChannel) return respond({ content: '❌ Bạn phải vào voice channel trước.' });

    if (command === 'p' || command === 'pn') {
        const query = context.options?.getString(command === 'p' ? 'query' : 'link') || args.join(' ').trim();
        if (!query || (command === 'pn' && !/^https?:\/\//i.test(query))) return respond({ content: '❌ Query/link không hợp lệ.' });
        const player = await ensurePlayer(guild, voiceChannel, context.channel);
        if (command === 'pn') {
            try { await player.stop(); } catch {}
            if (typeof player.queue?.clear === 'function') await player.queue.clear();
        }
        await player.play(query, context.user.id);
        await sendOrUpdateUI(guild.id, context.channel);
        return respond({ content: `▶️ Đã thêm: **${query}**` });
    }

    const player = getPlayer(guild.id);
    if (!player) return respond({ content: '❌ Chưa có player. Dùng /p trước.' });

    if (command === 'pa') { await player.pause(); playerStates.set(guild.id, 'paused'); }
    else if (command === 'r') { await player.resume(); playerStates.set(guild.id, 'playing'); }
    else if (command === 's') await player.skip();
    else if (command === 'st') { await player.stop(); playerStates.set(guild.id, 'stopped'); }
    else if (command === 'sh') await player.shuffle();
    else if (command === 'v') {
        const value = context.options?.getInteger('value') ?? Number(args[0]);
        if (!Number.isInteger(value) || value < 0 || value > 100) return respond({ content: '❌ Volume phải từ 0 đến 100.' });
        await player.setVolume(value);
        volumes.set(guild.id, value);
    } else if (command === 'l') {
        const mode = loops.get(guild.id) === 'queue' ? 'off' : 'queue';
        await player.loop(mode);
        loops.set(guild.id, mode);
    } else if (command === 'np') {
        return respond({ embeds: [new EmbedBuilder().setTitle('🎵 Now Playing').setDescription(getTrackTitle(player.queue?.currentTrack || player.currentTrack))] });
    } else if (command === 'q') {
        const tracks = getQueueTracks(player);
        return respond({ content: tracks.length ? tracks.slice(0, 20).map((track, index) => `**${index + 1}.** ${getTrackTitle(track)}`).join('\n') : '📭 Queue hiện đang trống.' });
    }

    await sendOrUpdateUI(guild.id, context.channel);
    return respond({ content: `✅ Đã xử lý /${command}.` });
}

const musicCommands = [
    ['p', 'Phát nhạc', 'query'], ['pn', 'Xóa queue và phát link mới', 'link'],
    ['pa', 'Tạm dừng nhạc'], ['r', 'Tiếp tục nhạc'], ['s', 'Bỏ qua bài hiện tại'],
    ['st', 'Dừng nhạc'], ['q', 'Xem queue'], ['np', 'Xem bài đang phát'],
    ['sh', 'Shuffle queue'], ['l', 'Bật/tắt queue loop'], ['v', 'Chỉnh volume', 'value']
].map(([name, description, option]) => {
    const command = new SlashCommandBuilder().setName(name).setDescription(description);
    if (option === 'query' || option === 'link') command.addStringOption(item => item.setName(option).setDescription('Tên hoặc link').setRequired(true));
    if (option === 'value') command.addIntegerOption(item => item.setName('value').setDescription('0 - 100').setMinValue(0).setMaxValue(100).setRequired(true));
    return command.toJSON();
});

async function handlePlayerButton(interaction) {
    if (!interaction.customId.startsWith(`music:${instance}:`)) return false;

    const guildId = interaction.guildId;
    const player = getPlayer(guildId);
    if (!player) {
        await interaction.reply({ content: '❌ Chưa có player.', ephemeral: true });
        return true;
    }

    const action = interaction.customId.split(':').pop();
    await interaction.deferUpdate();

    if (action === 'pause') {
        if (playerStates.get(guildId) === 'paused') {
            await player.resume();
            playerStates.set(guildId, 'playing');
        } else {
            await player.pause();
            playerStates.set(guildId, 'paused');
        }
    } else if (action === 'skip') {
        await player.skip();
    } else if (action === 'stop') {
        await player.stop();
        playerStates.set(guildId, 'stopped');
    } else if (action === 'shuffle') {
        await player.shuffle();
    } else if (action === 'loop') {
        const mode = loops.get(guildId) === 'queue' ? 'off' : 'queue';
        await player.loop(mode);
        loops.set(guildId, mode);
    }

    await sendOrUpdateUI(guildId);
    return true;
}

async function handleFilterMenu(interaction) {
    if (interaction.customId !== `music:${instance}:filter`) return false;

    const guildId = interaction.guildId;
    const player = getPlayer(guildId);
    if (!player) {
        await interaction.reply({ content: '❌ Chưa có player.', ephemeral: true });
        return true;
    }

    await interaction.deferUpdate();
    const selected = interaction.values[0];
    if (selected === 'none') await player.filter.clearAll();
    else await player.filter.applyFilters([selected]);
    filterState.set(guildId, selected);
    await sendOrUpdateUI(guildId);
    return true;
}

client.on('interactionCreate', interaction => {
    if (interaction.isButton()) {
        handlePlayerButton(interaction)
            .then(handled => {
                if (!handled && !interaction.replied && !interaction.deferred) {
                    return interaction.reply({ content: '❌ UI này đã cũ, hãy dùng message player mới.', ephemeral: true });
                }
                return null;
            })
            .catch(error => console.error('[UI BUTTON ERROR]', error.message));
        return;
    }
    if (interaction.isStringSelectMenu()) {
        handleFilterMenu(interaction)
            .then(handled => {
                if (!handled && !interaction.replied && !interaction.deferred) {
                    return interaction.reply({ content: '❌ Menu này đã cũ, hãy dùng filter menu mới.', ephemeral: true });
                }
                return null;
            })
            .catch(error => console.error('[UI FILTER ERROR]', error.message));
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    runMusicCommand(interaction.commandName, interaction).catch(error => {
        console.error('[MUSIC ERROR]', error);
        const response = { content: `❌ ${error.message || 'Có lỗi xảy ra.'}`, ephemeral: true };
        if (interaction.replied || interaction.deferred) interaction.editReply(response).catch(() => {}); else interaction.reply(response).catch(() => {});
    });
});

client.on('messageCreate', message => {
    if (message.author.bot || !message.guild || !message.content.startsWith('!')) return;
    const [rawCommand, ...args] = message.content.trim().split(/\s+/);
    const aliases = { '!p': 'p', '!play': 'p', '!pn': 'pn', '!pa': 'pa', '!pause': 'pa', '!r': 'r', '!resume': 'r', '!s': 's', '!skip': 's', '!st': 'st', '!stop': 'st', '!q': 'q', '!queue': 'q', '!np': 'np', '!nowplaying': 'np', '!sh': 'sh', '!shuffle': 'sh', '!l': 'l', '!loop': 'l', '!v': 'v', '!volume': 'v' };
    const command = aliases[rawCommand.toLowerCase()];
    if (!command) return;
    runMusicCommand(command, { guild: message.guild, member: message.member, channel: message.channel, user: message.author, reply: options => message.reply(options) }, args).catch(error => message.reply(`❌ ${error.message}`).catch(() => {}));
});

async function registerMusicCommands() {
    const rest = new REST({ version: '10' }).setToken(token);
    const route = process.env.GUILD_ID
        ? Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID)
        : Routes.applicationCommands(client.user.id);
    await rest.put(route, { body: musicCommands });
    console.log(`[SLAVE ${instance}] Music commands registered`);
}

manager.on('trackStart', async (player, track) => {
    const guildId = player?.guildId || player?.guildID;
    if (!guildId) return;
    playerStates.set(guildId, 'playing');
    await sendOrUpdateUI(guildId, player.userdata?.channel);
    console.log(`[SLAVE ${instance}] TRACK START | ${getTrackTitle(track)}`);
});

manager.on('trackEnd', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (guildId) await sendOrUpdateUI(guildId);
});

manager.on('queueAdd', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (guildId) await sendOrUpdateUI(guildId);
});

manager.on('queueAddList', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (guildId) await sendOrUpdateUI(guildId);
});

manager.on('playerPause', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (!guildId) return;
    playerStates.set(guildId, 'paused');
    await sendOrUpdateUI(guildId);
});

manager.on('playerResume', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (!guildId) return;
    playerStates.set(guildId, 'playing');
    await sendOrUpdateUI(guildId);
});

manager.on('queueEnd', async player => {
    const guildId = player?.guildId || player?.guildID;
    if (!guildId) return;
    playerStates.set(guildId, 'stopped');
    await sendOrUpdateUI(guildId);
});

manager.on('playerDestroy', player => {
    const guildId = player?.guildId || player?.guildID;
    if (!guildId) return;
    const timer = uiTimers.get(guildId);
    if (timer) clearInterval(timer);
    uiTimers.delete(guildId);
    uiMessages.delete(guildId);
    textChannels.delete(guildId);
    playerStates.delete(guildId);
    volumes.delete(guildId);
    loops.delete(guildId);
});


// ======================================================
// DISCORD READY
// ======================================================

client.once('clientReady', async () => {

    console.log(
        `[SLAVE ${instance}] ONLINE | ${client.user.tag} | HTTP :${port}`
    );

    await registerMusicCommands().catch(error => {
        console.error('[SLAVE COMMAND REGISTER ERROR]', error.message);
    });

    await notifyMaster('/slave/online');
});


// ======================================================
// VOICE STATE
// ======================================================

client.on(
    'voiceStateUpdate',
    async (oldState, newState) => {

        // Chỉ xử lý khi chính Slave bị disconnect
        if (
            oldState.member?.id !== client.user.id
        ) {
            return;
        }


        if (
            oldState.channelId &&
            !newState.channelId
        ) {

            const guildId =
                oldState.guild.id;

            const disconnectedPlayer = getPlayer(guildId);
            if (disconnectedPlayer) {
                try {
                    await disconnectedPlayer.stop();
                } catch {}
                try {
                    disconnectedPlayer.connection?.disconnect?.();
                } catch {}
            }

            const timer = uiTimers.get(guildId);
            if (timer) clearInterval(timer);
            uiTimers.delete(guildId);
            uiMessages.delete(guildId);
            playerStates.delete(guildId);

            connections.delete(guildId);


            await notifyMaster(
                '/slave/offline',
                {
                    guildId
                }
            );


            console.log(
                `[SLAVE ${instance}] VOICE LEFT | ${guildId}`
            );
        }
    }
);


// ======================================================
// START HTTP
// ======================================================

app.listen(port, () => {

    console.log(
        `[SLAVE ${instance}] HTTP :${port}`
    );
});

process.on('unhandledRejection', error => {
    console.error('[SLAVE UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', error => {
    console.error('[SLAVE UNCAUGHT EXCEPTION]', error);
});


// ======================================================
// LOGIN
// ======================================================

client.login(token);