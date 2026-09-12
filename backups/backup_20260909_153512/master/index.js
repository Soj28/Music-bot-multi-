require('dotenv').config({ quiet: true });

const express = require('express');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');


// ======================================================
// CONFIG
// ======================================================

const API_PORT = Number(
    process.env.MASTER_API_PORT || 4000
);

const MASTER_GUILD_ID =
    process.env.MASTER_GUILD_ID ||
    process.env.GUILD_ID ||
    null;

const MASTER_SECRET =
    process.env.MASTER_API_SECRET;

if (!process.env.MASTER_TOKEN) {
    throw new Error('Không tìm thấy MASTER_TOKEN');
}

if (!MASTER_SECRET) {
    throw new Error('Không tìm thấy MASTER_API_SECRET');
}


// ======================================================
// DISCORD CLIENT
// ======================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});


// ======================================================
// SLAVES
// ======================================================

const slaves = [
    {
        id: 'slave1',
        name: 'Music 1',
        port: Number(process.env.SLAVE_1_PORT || 4101),
        online: false,
        assignments: new Map()
    },

    {
        id: 'slave2',
        name: 'Music 2',
        port: Number(process.env.SLAVE_2_PORT || 4102),
        online: false,
        assignments: new Map()
    },

    {
        id: 'slave3',
        name: 'Music 3',
        port: Number(process.env.SLAVE_3_PORT || 4103),
        online: false,
        assignments: new Map()
    },

    {
        id: 'slave4',
        name: 'Music 4',
        port: Number(process.env.SLAVE_4_PORT || 4104),
        online: false,
        assignments: new Map()
    },

    {
        id: 'slave5',
        name: 'Music 5',
        port: Number(process.env.SLAVE_5_PORT || 4105),
        online: false,
        assignments: new Map()
    }
];


// ======================================================
// ASSIGNMENTS
//
// guildId -> Map(channelId -> slaveId)
// ======================================================

const assignments = new Map();


// ======================================================
// JOIN LOCK
//
// Chống 2 người /join cùng lúc lấy cùng một Slave.
// guildId -> Promise
// ======================================================

const guildLocks = new Map();

async function withGuildLock(guildId, task) {

    const previous =
        guildLocks.get(guildId) || Promise.resolve();

    let release;

    const current = new Promise(resolve => {
        release = resolve;
    });

    const chain = previous.then(() => current);

    guildLocks.set(
        guildId,
        chain
    );

    try {

        await previous;

        return await task();

    } finally {

        release();

        if (guildLocks.get(guildId) === chain) {
            guildLocks.delete(guildId);
        }
    }
}


// ======================================================
// HELPERS
// ======================================================

function getSlave(slaveId) {

    return slaves.find(
        slave => slave.id === slaveId
    );
}

function getAssignedSlave(
    guildId,
    channelId
) {
    const guildAssignments =
        assignments.get(guildId);

    if (!guildAssignments) {
        return null;
    }

    const slaveId =
        guildAssignments.get(channelId);

    return slaveId
        ? getSlave(slaveId)
        : null;
}

function findFreeSlave(guildId) {
    return slaves.find(slave => {
        if (!slave.online) {
            return false;
        }

        return !slave.assignments.has(guildId);
    });
}

function reserveSlave(
    slave,
    guildId,
    channelId
) {

    if (!assignments.has(guildId)) {
        assignments.set(
            guildId,
            new Map()
        );
    }

    assignments
        .get(guildId)
        .set(channelId, slave.id);

    slave.assignments.set(
        guildId,
        channelId
    );
}


function releaseSlave(
    slave,
    guildId,
    channelId
) {

    const guildAssignments =
        assignments.get(guildId);

    if (guildAssignments) {

        guildAssignments.delete(channelId);

        if (guildAssignments.size === 0) {
            assignments.delete(guildId);
        }
    }

    slave.assignments.delete(guildId);
}


function releaseAllSlaveAssignments(slave) {

    for (
        const [guildId, channelId]
        of slave.assignments
    ) {

        const guildAssignments =
            assignments.get(guildId);

        if (guildAssignments) {

            guildAssignments.delete(channelId);

            if (guildAssignments.size === 0) {
                assignments.delete(guildId);
            }
        }
    }

    slave.assignments.clear();
}


// ======================================================
// CALL SLAVE
// ======================================================

async function callSlave(
    slave,
    endpoint,
    body = {}
) {

    const controller =
        new AbortController();

    const timeout =
        setTimeout(
            () => controller.abort(),
            10000
        );

    try {

        const response =
            await fetch(
                `http://127.0.0.1:${slave.port}${endpoint}`,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json',

                        'Authorization':
                            `Bearer ${MASTER_SECRET}`
                    },

                    body: JSON.stringify(body),

                    signal: controller.signal
                }
            );


        const text =
            await response.text();


        if (!response.ok) {

            throw new Error(
                text || `HTTP ${response.status}`
            );
        }


        try {

            return JSON.parse(text);

        } catch {

            return {
                success: true,
                message: text
            };
        }

    } finally {

        clearTimeout(timeout);
    }
}


// ======================================================
// SLASH COMMANDS
// ======================================================

const commands = [

    new SlashCommandBuilder()
        .setName('join')
        .setDescription(
            'Cho một bot music vào voice channel'
        ),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription(
            'Cho bot music rời voice channel'
        ),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription(
            'Xem trạng thái 5 bot music'
        ),

    new SlashCommandBuilder()
        .setName('clear')
        .setDescription(
            'Xóa tin nhắn trong kênh'
        )
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription(
                    'Số tin nhắn cần xóa'
                )
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages
        )

].map(command => command.toJSON());


// ======================================================
// REGISTER COMMANDS
// ======================================================
async function registerCommands() {
    const rest = new REST({ version: '10' })
        .setToken(process.env.MASTER_TOKEN);

    const application = await client.application.fetch();
    const applicationId = application.id;

    if (!MASTER_GUILD_ID) {
        await rest.put(
            Routes.applicationCommands(applicationId),
            { body: [] }
        );
    }

    const route = MASTER_GUILD_ID
        ? Routes.applicationGuildCommands(
              applicationId,
              MASTER_GUILD_ID
          )
        : Routes.applicationCommands(applicationId);

    await rest.put(route, { body: commands });

    console.log(
        `[SYSTEM] Commands registered ${
            MASTER_GUILD_ID
                ? `for guild ${MASTER_GUILD_ID}`
                : 'globally'
        } | /join /leave /status /clear`
    );
}

// ======================================================
// READY
// ======================================================

client.once(
    'clientReady',
    async () => {

        console.log(
            `[MASTER] ONLINE | ${client.user.tag} | API :${API_PORT}`
        );


        try {

            await registerCommands();

        } catch (error) {

            console.error(
                `[ERROR] Commands | ${error.message}`
            );
        }
    }
);


// ======================================================
// INTERACTIONS
// ======================================================

client.on(
    'interactionCreate',
    async interaction => {

        if (!interaction.isChatInputCommand()) {
            return;
        }


        const guildId =
            interaction.guildId;


        if (!guildId) {

            await interaction.reply({
                content:
                    'Lệnh này chỉ dùng trong server.',
                ephemeral: true
            });

            return;
        }


        try {

            // ==================================================
            // /JOIN
            // ==================================================

            if (
                interaction.commandName === 'join'
            ) {

                await interaction.deferReply({
                    ephemeral: true
                });

                await withGuildLock(
                    guildId,
                    async () => {

                        const voiceChannel =
                            interaction.member.voice.channel;


                        if (!voiceChannel) {

                            await interaction.editReply({
                                content:
                                    'Bạn phải vào voice channel trước.'
                            });

                            return;
                        }


                        const channelId =
                            voiceChannel.id;


                        // ------------------------------------------
                        // Đã có Slave?
                        // ------------------------------------------

                        const existing =
                            getAssignedSlave(
                                guildId,
                                channelId
                            );


                        if (existing) {

                            await interaction.editReply({
                                content:
                                    `🎵 **${existing.name}** đang ở channel này.`
                            });

                            return;
                        }


                        // ------------------------------------------
                        // Tìm Slave
                        // ------------------------------------------

                        const slave =
                            findFreeSlave(guildId);


                        if (!slave) {

                            await interaction.editReply({
                                content:
                                    '❌ Không còn Slave rảnh trong server này.'
                            });

                            return;
                        }


                        // ------------------------------------------
                        // Reserve
                        // ------------------------------------------

                        reserveSlave(
                            slave,
                            guildId,
                            channelId
                        );


                        try {

                            const result =
                                await callSlave(
                                    slave,
                                    '/join',
                                    {
                                        guildId,
                                        channelId
                                    }
                                );


                            if (
                                result &&
                                result.success === false
                            ) {
                                throw new Error(
                                    result.error ||
                                    'Slave join failed'
                                );
                            }


                            console.log(
                                `[JOIN] ${slave.name} -> ${voiceChannel.name}`
                            );


                            await interaction.editReply(
                                `🎵 **${slave.name}** đã vào **${voiceChannel.name}**.`
                            );


                        } catch (error) {

                            releaseSlave(
                                slave,
                                guildId,
                                channelId
                            );


                            console.error(
                                `[ERROR] JOIN | ${slave.name} | ${error.message}`
                            );


                            await interaction.editReply(
                                '❌ Không thể cho bot music vào voice channel.'
                            );
                        }
                    }
                );

                return;
            }


            // ==================================================
            // /LEAVE
            // ==================================================

            if (
                interaction.commandName === 'leave'
            ) {

                const voiceChannel =
                    interaction.member.voice.channel;


                if (!voiceChannel) {

                    await interaction.reply({
                        content:
                            'Bạn phải ở voice channel.',
                        ephemeral: true
                    });

                    return;
                }


                const channelId =
                    voiceChannel.id;


                const slave =
                    getAssignedSlave(
                        guildId,
                        channelId
                    );


                if (!slave) {

                    await interaction.reply({
                        content:
                            '❌ Không có bot music nào trong channel này.',
                        ephemeral: true
                    });

                    return;
                }


                await interaction.deferReply();


                try {

                    await callSlave(
                        slave,
                        '/leave',
                        {
                            guildId
                        }
                    );


                    releaseSlave(
                        slave,
                        guildId,
                        channelId
                    );


                    console.log(
                        `[LEAVE] ${slave.name} <- ${voiceChannel.name}`
                    );


                    await interaction.editReply(
                        `👋 **${slave.name}** đã rời **${voiceChannel.name}**.`
                    );


                } catch (error) {

                    console.error(
                        `[ERROR] LEAVE | ${slave.name} | ${error.message}`
                    );


                    await interaction.editReply(
                        '❌ Không thể cho bot rời voice channel.'
                    );
                }

                return;
            }


            // ==================================================
            // /STATUS
            // ==================================================

            if (
                interaction.commandName === 'status'
            ) {

                let text =
                    '### 🤖 Bot Music Status\n\n';


                for (const slave of slaves) {

                    const channelId =
                        slave.assignments.get(
                            guildId
                        );


                    if (!slave.online) {

                        text +=
                            `🔴 **${slave.name}** → Offline\n`;

                    } else if (channelId) {

                        text +=
                            `🟢 **${slave.name}** → <#${channelId}>\n`;

                    } else {

                        text +=
                            `⚪ **${slave.name}** → Rảnh\n`;
                    }
                }


                await interaction.reply({
                    content: text,
                    ephemeral: true
                });

                return;
            }


            // ==================================================
            // /CLEAR
            // ==================================================

            if (
                interaction.commandName === 'clear'
            ) {

                const amount =
                    interaction.options.getInteger(
                        'amount'
                    );


                const channel =
                    interaction.channel;


                if (!channel) {

                    await interaction.reply({
                        content:
                            'Không xác định được channel.',
                        ephemeral: true
                    });

                    return;
                }


                const permissions =
                    channel.permissionsFor(
                        interaction.guild.members.me
                    );


                if (
                    !permissions ||
                    !permissions.has(
                        PermissionFlagsBits.ManageMessages
                    )
                ) {

                    await interaction.reply({
                        content:
                            '❌ Bot Master cần quyền Manage Messages.',
                        ephemeral: true
                    });

                    return;
                }


                await interaction.deferReply({
                    ephemeral: true
                });


                try {

                    const deleted =
                        await channel.bulkDelete(
                            amount,
                            true
                        );


                    await interaction.editReply(
                        `🧹 Đã xóa **${deleted.size}** tin nhắn.`
                    );


                } catch (error) {

                    console.error(
                        `[ERROR] CLEAR | ${error.message}`
                    );


                    await interaction.editReply(
                        '❌ Không thể xóa tin nhắn.'
                    );
                }

                return;
            }

        } catch (error) {

            console.error(
                `[ERROR] INTERACTION | ${error.message}`
            );


            try {

                if (
                    interaction.replied ||
                    interaction.deferred
                ) {

                    await interaction.editReply(
                        '❌ Đã xảy ra lỗi.'
                    );

                } else {

                    await interaction.reply({
                        content:
                            '❌ Đã xảy ra lỗi.',
                        ephemeral: true
                    });
                }

            } catch {
                // Không làm bot crash nếu Discord đã timeout
            }
        }
    }
);


// ======================================================
// MASTER API
// ======================================================

const app = express();

app.use(express.json());


// ======================================================
// AUTH
// ======================================================

function authenticate(
    req,
    res,
    next
) {

    const auth =
        req.headers.authorization;


    if (
        auth !==
        `Bearer ${MASTER_SECRET}`
    ) {

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
// SLAVE ONLINE
// ======================================================

app.post(
    '/slave/online',
    (req, res) => {

        const slave =
            getSlave(
                req.body.slaveId
            );


        if (!slave) {

            return res
                .status(404)
                .json({
                    success: false,
                    error: 'Slave not found'
                });
        }


        slave.online = true;


        console.log(
            `[MASTER] ${slave.name} ONLINE`
        );


        res.json({
            success: true
        });
    }
);


// ======================================================
// SLAVE OFFLINE
// ======================================================

app.post(
    '/slave/offline',
    (req, res) => {

        const slave =
            getSlave(
                req.body.slaveId
            );


        if (!slave) {

            return res
                .status(404)
                .json({
                    success: false,
                    error: 'Slave not found'
                });
        }


        const guildId = req.body.guildId;

        if (guildId) {
            const channelId =
                slave.assignments.get(guildId);

            if (channelId) {
                releaseSlave(
                    slave,
                    guildId,
                    channelId
                );
            }
        } else {
            slave.online = false;
            releaseAllSlaveAssignments(slave);
        }


        console.log(
            `[MASTER] ${slave.name} VOICE DISCONNECTED${
                guildId ? ` | ${guildId}` : ''
            }`
        );


        res.json({
            success: true
        });
    }
);


// ======================================================
// SLAVE STATUS
// ======================================================

app.post(
    '/slave/status',
    (req, res) => {

        const {
            slaveId,
            guildId,
            channelId
        } = req.body;


        const slave =
            getSlave(slaveId);


        if (!slave) {

            return res
                .status(404)
                .json({
                    success: false,
                    error: 'Slave not found'
                });
        }


        slave.online = true;


        if (
            guildId &&
            channelId
        ) {

            const previousChannelId =
                slave.assignments.get(guildId);

            if (
                previousChannelId &&
                previousChannelId !== channelId
            ) {
                releaseSlave(
                    slave,
                    guildId,
                    previousChannelId
                );
            }

            reserveSlave(
                slave,
                guildId,
                channelId
            );
        }


        res.json({
            success: true
        });
    }
);


// ======================================================
// API START
// ======================================================

app.listen(
    API_PORT,
    () => {

        console.log(
            `[MASTER] API :${API_PORT}`
        );
    }
);


// ======================================================
// LOGIN
// ======================================================

client.login(
    process.env.MASTER_TOKEN
);