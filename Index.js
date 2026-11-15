const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    ChannelType,
    PermissionFlagsBits
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const PREFIX = "!";
const OWNER_ID = "1400164749655674953";
const COR = 0x8e44ad;
const COR_AVISO = 0xf1c40f;

// Comandos que qualquer pessoa pode usar. O resto é só do dono.
const PUBLICOS = new Set([
    "menu", "ia", "ping", "status",
    "avatar", "userinfo", "roleinfo", "infocargo", "listarcargos", "servidor",
    "google", "imagens", "videos", "noticias", "maps", "youtube"
]);

// Limites das proteções automáticas
const SPAM = { mensagens: 6, janela: 5000 };  // 6 mensagens em 5 segundos
const RAID = { entradas: 5, janela: 10000 };  // 5 entradas em 10 segundos
const REGEX_CONVITE = /(discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;

let logs = [];
const cooldown = new Map();
const configs = new Map();           // guildId -> { antispam, antiraid, antiinvite, lockdown }
const avisos = new Map();            // "guildId:userId" -> [{ motivo, por, data }]
const msgsRecentes = new Map();      // "guildId:userId" -> [timestamps]
const entradasRecentes = new Map();  // guildId -> [timestamps]

function addLog(msg) {
    logs.push(msg);
    if (logs.length > 20) logs.shift();
    console.log(msg);
}

process.on("unhandledRejection", err => {
    addLog("[ERRO] " + err.message);
});

// ===== Helpers =====

const uso = (message, sintaxe) =>
    message.reply(`❌ Uso: \`${PREFIX}${sintaxe}\``);

// Mensagem que some sozinha depois de alguns segundos
async function temp(canal, texto, ms = 5000) {
    const aviso = await canal.send(texto).catch(() => null);
    if (aviso) setTimeout(() => aviso.delete().catch(() => {}), ms);
}

// Tira a menção do começo do texto: "<@123> novo nome" -> "novo nome"
const semMencao = texto => texto.replace(/^<[@#]&?!?\d+>\s*/, "");

// "#ff0000" -> número da cor (ou null se não for cor)
function parseCor(texto) {
    const m = /^#?([0-9a-f]{6})$/i.exec(texto || "");
    return m ? parseInt(m[1], 16) : null;
}

// "managemessages" -> permissão do Discord (ou null)
function permissao(nome) {
    const chave = Object.keys(PermissionFlagsBits)
        .find(k => k.toLowerCase() === (nome || "").toLowerCase());
    return chave ? PermissionFlagsBits[chave] : null;
}

function config(guildId) {
    if (!configs.has(guildId)) {
        configs.set(guildId, { antispam: false, antiraid: false, antiinvite: false, lockdown: false });
    }
    return configs.get(guildId);
}

const ehDono = message => message.author.id === OWNER_ID;

// Não passam pelas proteções automáticas: o dono e quem pode gerenciar mensagens
const isento = message =>
    ehDono(message) || !!message.member?.permissions.has(PermissionFlagsBits.ManageMessages);

// Mensagem alvo: a que foi respondida ou a do id passado
async function pegarMensagem(message, id) {
    const alvoId = id || message.reference?.messageId;
    if (!alvoId) return null;
    return message.channel.messages.fetch(alvoId).catch(() => null);
}

// Tira (ou devolve) a permissão de enviar mensagens do @everyone nos canais de texto
async function travarCanais(guild, travar) {
    const canais = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
    for (const canal of canais.values()) {
        await canal.permissionOverwrites
            .edit(guild.roles.everyone, { SendMessages: travar ? false : null })
            .catch(() => {});
    }
}

// Liga/desliga antispam, antiraid e antiinvite. Sem opção, mostra o estado.
async function alternar(message, args, chave) {
    const cfg = config(message.guild.id);
    const opcao = (args[0] || "").toLowerCase();

    if (!opcao) {
        return message.reply(`🛡️ **${chave}** está ${cfg[chave] ? "ativado" : "desativado"}. Use \`!${chave} on\` ou \`!${chave} off\`.`);
    }
    if (opcao !== "on" && opcao !== "off") return uso(message, `${chave} on|off`);

    cfg[chave] = opcao === "on";
    addLog(`[${chave.toUpperCase()}] ${cfg[chave] ? "ativado" : "desativado"} por ${message.author.tag}`);
    return message.reply(`🛡️ **${chave}** ${cfg[chave] ? "ativado" : "desativado"}.`);
}

// Pesquisas: mandam um link já com a busca feita
const pesquisa = (cmd, icone, nome, base) => async (message, args, resto) => {
    const termo = resto.trim();
    if (!termo) return uso(message, `${cmd} <termo>`);
    const embed = new EmbedBuilder()
        .setTitle(`${icone} ${nome}: ${termo.slice(0, 200)}`)
        .setURL(base + encodeURIComponent(termo))
        .setDescription("Clique no título para ver os resultados.")
        .setColor(COR);
    return message.reply({ embeds: [embed] });
};

// Proteções automáticas, rodam antes dos comandos. Retorna true se barrou a mensagem.
async function aplicarProtecoes(message) {
    if (isento(message)) return false;
    const cfg = config(message.guild.id);

    if (cfg.antiinvite && REGEX_CONVITE.test(message.content)) {
        await message.delete().catch(() => {});
        addLog(`[ANTIINVITE] ${message.author.tag} enviou convite`);
        await temp(message.channel, `🚫 ${message.author}, convites não são permitidos aqui.`);
        return true;
    }

    if (cfg.antispam) {
        const chave = `${message.guild.id}:${message.author.id}`;
        const agora = Date.now();
        const lista = (msgsRecentes.get(chave) || []).filter(t => agora - t < SPAM.janela);
        lista.push(agora);
        msgsRecentes.set(chave, lista);

        if (lista.length >= SPAM.mensagens) {
            msgsRecentes.delete(chave);
            await message.delete().catch(() => {});
            await message.member?.timeout(60000, "Antispam").catch(() => {});
            addLog(`[ANTISPAM] ${message.author.tag} silenciado por 1 min`);
            await temp(message.channel, `🚫 ${message.author}, spam detectado: silenciado por 1 minuto.`);
            return true;
        }
    }

    return false;
}

// Painel de comandos (mesmo layout da imagem)
function montarMenu() {
    return new EmbedBuilder()
        .setTitle("📌 MENU")
        .setColor(COR)
        .addFields(
            { name: "🤖 SISTEMA", value: "`!menu` • `!ping` • `!status` • `!restart`" },
            { name: "🛡️ GERENCIAMENTO DE MEMBROS", value: "`!ban` • `!unban` • `!kick`\n`!mute` • `!unmute`\n`!nick` • `!limparapelido`\n`!avatar` • `!userinfo` • `!roleinfo`" },
            { name: "🎭 GERENCIAMENTO DE CARGOS", value: "`!criarcargo` • `!excluircargo` • `!editarnomecargo`\n`!corcargo` • `!adicionarperm` • `!removerperm`\n`!darcargo` • `!retirarcargo`\n`!listarcargos` • `!infocargo`" },
            { name: "📁 GERENCIAMENTO DE CANAIS", value: "`!criarcanal` • `!criarvoz` • `!apagarcanal`\n`!renomearcanal` • `!topico`\n`!trancar` • `!destrancar`\n`!slowmode` • `!nsfw`" },
            { name: "💬 GERENCIAMENTO DE MENSAGENS", value: "`!limpar` • `!limparuser`\n`!fixar` • `!desafixar`\n`!anunciar` • `!embed` • `!say` • `!reagir`" },
            { name: "⚙️ ADMINISTRAÇÃO DO SERVIDOR", value: "`!servidor` • `!iconserver` • `!nomeServer` • `!banner`\n`!invites` • `!criaconvite` • `!deletaconvite`\n`!lockserver` • `!unlockserver`" },
            { name: "🔰 PROTEÇÃO E AUDITORIA", value: "`!logs` • `!antispam` • `!antiraid` • `!antiinvite`\n`!warn` • `!warnings` • `!clearwarn`\n`!lockdown`" },
            { name: "🔎 PESQUISAS", value: "`!google` • `!imagens` • `!videos`\n`!noticias` • `!maps` • `!youtube`" }
        )
        .setFooter({ text: "Bot de Administração • Painel de comandos" })
        .setTimestamp();
}

const comandos = {
    // ===== Sistema =====
    menu: message => message.reply({ embeds: [montarMenu()] }),

    ia: message => message.reply("Comando indisponível."),

    ping: async message => {
        const sent = await message.reply("...");
        const latencia = sent.createdTimestamp - message.createdTimestamp;
        return sent.edit(`Latência: ${latencia}ms | API: ${Math.round(client.ws.ping)}ms`);
    },

    status: message =>
        message.reply(`Status: online\nPing: ${Math.round(client.ws.ping)}ms\nUptime: ${Math.floor(process.uptime())}s`),

    restart: async message => {
        addLog("[RESTART]");
        await message.reply("Reiniciando...");
        process.exit(1);
    },

    // ===== Membros =====
    ban: async (message, args, resto) => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "ban @usuário [motivo]");
        await message.guild.bans.create(user.id, { reason: semMencao(resto) || "Sem motivo" });
        addLog(`[BAN] ${user.tag} por ${message.author.tag}`);
        return message.reply(`🔨 Banido: ${user.tag}`);
    },

    unban: async (message, args) => {
        const id = (args[0] || "").replace(/\D/g, "");
        if (!id) return uso(message, "unban <id>");
        await message.guild.bans.remove(id);
        addLog(`[UNBAN] ${id} por ${message.author.tag}`);
        return message.reply(`✅ Desbanido: \`${id}\``);
    },

    kick: async (message, args, resto) => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "kick @usuário [motivo]");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.kick(semMencao(resto) || "Sem motivo");
        addLog(`[KICK] ${user.tag} por ${message.author.tag}`);
        return message.reply(`👢 Expulso: ${user.tag}`);
    },

    mute: async (message, args) => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "mute @usuário [minutos]");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        const minutos = Math.min(Math.max(parseInt(args[1], 10) || 10, 1), 40320);
        await membro.timeout(minutos * 60000);
        addLog(`[MUTE] ${user.tag} por ${minutos} min`);
        return message.reply(`🔇 ${user.tag} mutado por ${minutos} min.`);
    },

    unmute: async message => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "unmute @usuário");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.timeout(null);
        return message.reply(`🔊 Mute removido: ${user.tag}`);
    },

    nick: async (message, args, resto) => {
        const user = message.mentions.users.first();
        const apelido = semMencao(resto).slice(0, 32);
        if (!user || !apelido) return uso(message, "nick @usuário novo apelido");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.setNickname(apelido);
        return message.reply(`✏️ Apelido de ${user.tag} agora é **${apelido}**`);
    },

    limparapelido: async message => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "limparapelido @usuário");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.setNickname(null);
        return message.reply(`✅ Apelido de ${user.tag} removido.`);
    },

    avatar: message => {
        const user = message.mentions.users.first() || message.author;
        const embed = new EmbedBuilder()
            .setTitle(`🖼️ Avatar de ${user.username}`)
            .setImage(user.displayAvatarURL({ size: 1024 }))
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    userinfo: async message => {
        const user = message.mentions.users.first() || message.author;
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        const embed = new EmbedBuilder()
            .setTitle(`👤 ${user.tag}`)
            .setThumbnail(user.displayAvatarURL({ size: 256 }))
            .setColor(COR)
            .addFields(
                { name: "ID", value: user.id, inline: true },
                { name: "Conta criada", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true },
                { name: "Entrou em", value: membro?.joinedTimestamp ? `<t:${Math.floor(membro.joinedTimestamp / 1000)}:D>` : "—", inline: true },
                { name: "Maior cargo", value: membro ? membro.roles.highest.toString() : "—", inline: true }
            );
        return message.reply({ embeds: [embed] });
    },

    roleinfo: async message => {
        const user = message.mentions.users.first() || message.author;
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        const cargos = membro.roles.cache
            .filter(r => r.id !== message.guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => r.toString());
        const embed = new EmbedBuilder()
            .setTitle(`🎭 Cargos de ${user.username}`)
            .setDescription((cargos.join(" ") || "Nenhum cargo.").slice(0, 4000))
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    // ===== Cargos =====
    criarcargo: async (message, args) => {
        const partes = [...args];
        const cor = parseCor(partes[partes.length - 1]);
        if (cor !== null) partes.pop();
        const nome = partes.join(" ").slice(0, 100);
        if (!nome) return uso(message, "criarcargo <nome> [#cor]");
        const cargo = await message.guild.roles.create({ name: nome, color: cor ?? undefined });
        addLog(`[CRIARCARGO] ${nome} por ${message.author.tag}`);
        return message.reply(`✅ Cargo criado: ${cargo}`);
    },

    excluircargo: async message => {
        const cargo = message.mentions.roles.first();
        if (!cargo) return uso(message, "excluircargo @cargo");
        const nome = cargo.name;
        await cargo.delete(`Excluído por ${message.author.tag}`);
        return message.reply(`🗑️ Cargo **${nome}** excluído.`);
    },

    editarnomecargo: async (message, args, resto) => {
        const cargo = message.mentions.roles.first();
        const nome = semMencao(resto).slice(0, 100);
        if (!cargo || !nome) return uso(message, "editarnomecargo @cargo novo nome");
        await cargo.setName(nome);
        return message.reply(`✏️ Cargo renomeado para **${nome}**`);
    },

    corcargo: async (message, args) => {
        const cargo = message.mentions.roles.first();
        const cor = parseCor(args[args.length - 1]);
        if (!cargo || cor === null) return uso(message, "corcargo @cargo #RRGGBB");
        await cargo.setColor(cor);
        return message.reply(`🎨 Cor do cargo **${cargo.name}** atualizada.`);
    },

    adicionarperm: async (message, args) => {
        const cargo = message.mentions.roles.first();
        const nome = args[args.length - 1];
        const bit = permissao(nome);
        if (!cargo || !bit) return uso(message, "adicionarperm @cargo NomeDaPermissao (ex: ManageMessages)");
        await cargo.setPermissions(cargo.permissions.add(bit));
        return message.reply(`✅ Permissão **${nome}** adicionada ao cargo **${cargo.name}**.`);
    },

    removerperm: async (message, args) => {
        const cargo = message.mentions.roles.first();
        const nome = args[args.length - 1];
        const bit = permissao(nome);
        if (!cargo || !bit) return uso(message, "removerperm @cargo NomeDaPermissao (ex: ManageMessages)");
        await cargo.setPermissions(cargo.permissions.remove(bit));
        return message.reply(`✅ Permissão **${nome}** removida do cargo **${cargo.name}**.`);
    },

    darcargo: async message => {
        const user = message.mentions.users.first();
        const cargo = message.mentions.roles.first();
        if (!user || !cargo) return uso(message, "darcargo @usuário @cargo");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.roles.add(cargo);
        return message.reply(`✅ Cargo **${cargo.name}** entregue a ${user.tag}.`);
    },

    retirarcargo: async message => {
        const user = message.mentions.users.first();
        const cargo = message.mentions.roles.first();
        if (!user || !cargo) return uso(message, "retirarcargo @usuário @cargo");
        const membro = await message.guild.members.fetch(user.id).catch(() => null);
        if (!membro) return message.reply("Esse usuário não está no servidor.");
        await membro.roles.remove(cargo);
        return message.reply(`✅ Cargo **${cargo.name}** removido de ${user.tag}.`);
    },

    listarcargos: message => {
        const linhas = message.guild.roles.cache
            .filter(r => r.id !== message.guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => `${r} • ${r.members.size} membro(s)`);
        const embed = new EmbedBuilder()
            .setTitle(`🎭 Cargos (${linhas.length})`)
            .setDescription((linhas.join("\n") || "Nenhum cargo.").slice(0, 4000))
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    infocargo: message => {
        const cargo = message.mentions.roles.first();
        if (!cargo) return uso(message, "infocargo @cargo");
        const embed = new EmbedBuilder()
            .setTitle(`🎭 ${cargo.name}`)
            .setColor(cargo.color || COR)
            .addFields(
                { name: "ID", value: cargo.id, inline: true },
                { name: "Cor", value: cargo.hexColor, inline: true },
                { name: "Membros", value: String(cargo.members.size), inline: true },
                { name: "Mencionável", value: cargo.mentionable ? "Sim" : "Não", inline: true },
                { name: "Permissões", value: (cargo.permissions.toArray().join(", ") || "Nenhuma").slice(0, 1024) }
            );
        return message.reply({ embeds: [embed] });
    },

    // ===== Canais =====
    criarcanal: async (message, args) => {
        const nome = args.join("-").toLowerCase().slice(0, 100);
        if (!nome) return uso(message, "criarcanal <nome>");
        const canal = await message.guild.channels.create({ name: nome, type: ChannelType.GuildText });
        addLog(`[CRIARCANAL] ${nome} por ${message.author.tag}`);
        return message.reply(`✅ Canal criado: ${canal}`);
    },

    criarvoz: async (message, args, resto) => {
        const nome = resto.slice(0, 100);
        if (!nome) return uso(message, "criarvoz <nome>");
        const canal = await message.guild.channels.create({ name: nome, type: ChannelType.GuildVoice });
        return message.reply(`🔊 Canal de voz criado: **${canal.name}**`);
    },

    apagarcanal: async message => {
        const canal = message.mentions.channels.first() || message.channel;
        const nome = canal.name;
        await canal.delete(`Apagado por ${message.author.tag}`);
        addLog(`[APAGARCANAL] ${nome} por ${message.author.tag}`);
        if (canal.id !== message.channel.id) return message.reply(`🗑️ Canal **${nome}** apagado.`);
    },

    renomearcanal: async (message, args, resto) => {
        const canal = message.mentions.channels.first();
        const nome = semMencao(resto).replace(/\s+/g, "-").toLowerCase().slice(0, 100);
        if (!canal || !nome) return uso(message, "renomearcanal #canal novo-nome");
        await canal.setName(nome);
        return message.reply(`✏️ Canal renomeado para **${nome}**`);
    },

    topico: async (message, args, resto) => {
        if (message.channel.type !== ChannelType.GuildText) return message.reply("Use em um canal de texto.");
        if (!resto) return uso(message, "topico <texto>");
        await message.channel.setTopic(resto.slice(0, 1024));
        return message.reply("📝 Tópico atualizado.");
    },

    trancar: async message => {
        await message.reply("🔒 Canal trancado.");
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    },

    destrancar: async message => {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        return message.reply("🔓 Canal destrancado.");
    },

    slowmode: async (message, args) => {
        const segundos = parseInt(args[0], 10);
        if (isNaN(segundos) || segundos < 0 || segundos > 21600) return uso(message, "slowmode <0 a 21600>");
        await message.channel.setRateLimitPerUser(segundos);
        return message.reply(segundos ? `🐌 Modo lento: ${segundos}s entre mensagens.` : "⚡ Modo lento desativado.");
    },

    nsfw: async message => {
        const canal = await message.channel.setNSFW(!message.channel.nsfw);
        return message.reply(canal.nsfw ? "🔞 Canal marcado como NSFW." : "✅ Canal não é mais NSFW.");
    },

    // ===== Mensagens =====
    limpar: async (message, args) => {
        const quantidade = parseInt(args[0], 10);
        if (isNaN(quantidade) || quantidade < 1 || quantidade > 100) return uso(message, "limpar <1 a 100>");
        await message.delete().catch(() => {});
        const apagadas = await message.channel.bulkDelete(quantidade, true);
        return temp(message.channel, `🧹 ${apagadas.size} mensagem(ns) apagada(s).`);
    },

    limparuser: async (message, args) => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "limparuser @usuário [quantidade]");
        const quantidade = Math.min(parseInt(args[1], 10) || 10, 100);
        await message.delete().catch(() => {});
        const recentes = await message.channel.messages.fetch({ limit: 100 });
        const alvo = recentes.filter(m => m.author.id === user.id).first(quantidade);
        if (!alvo.length) return temp(message.channel, `Nenhuma mensagem recente de ${user.tag}.`);
        const apagadas = await message.channel.bulkDelete(alvo, true);
        return temp(message.channel, `🧹 ${apagadas.size} mensagem(ns) de ${user.tag} apagada(s).`);
    },

    fixar: async (message, args) => {
        const alvo = await pegarMensagem(message, args[0]);
        if (!alvo) return uso(message, "fixar (respondendo uma mensagem) ou fixar <id>");
        await alvo.pin();
        return message.reply("📌 Mensagem fixada.");
    },

    desafixar: async (message, args) => {
        const alvo = await pegarMensagem(message, args[0]);
        if (!alvo) return uso(message, "desafixar (respondendo uma mensagem) ou desafixar <id>");
        await alvo.unpin();
        return message.reply("📌 Mensagem desafixada.");
    },

    anunciar: async (message, args, resto) => {
        const canal = message.mentions.channels.first() || message.channel;
        const texto = semMencao(resto).slice(0, 4000);
        if (!texto) return uso(message, "anunciar [#canal] texto");
        const embed = new EmbedBuilder()
            .setTitle("📢 Anúncio")
            .setDescription(texto)
            .setColor(COR)
            .setFooter({ text: `Por ${message.author.tag}` })
            .setTimestamp();
        await message.delete().catch(() => {});
        await canal.send({ embeds: [embed] });
        if (canal.id !== message.channel.id) return temp(message.channel, `✅ Anúncio enviado em ${canal}.`);
    },

    embed: async (message, args, resto) => {
        if (!resto) return uso(message, "embed Título | Descrição");
        const [titulo, ...partes] = resto.split("|");
        const descricao = partes.join("|").trim();
        const embed = new EmbedBuilder().setColor(COR);
        if (descricao && titulo.trim()) {
            embed.setTitle(titulo.trim().slice(0, 256)).setDescription(descricao.slice(0, 4000));
        } else {
            embed.setDescription((descricao || titulo).trim().slice(0, 4000));
        }
        await message.delete().catch(() => {});
        return message.channel.send({ embeds: [embed] });
    },

    say: async (message, args, resto) => {
        if (!resto) return uso(message, "say texto");
        await message.delete().catch(() => {});
        return message.channel.send(resto.slice(0, 2000));
    },

    reagir: async (message, args) => {
        const respondendo = message.reference?.messageId;
        const alvoId = respondendo || args[0];
        const emoji = respondendo ? args[0] : args[1];
        if (!alvoId || !emoji) return uso(message, "reagir <emoji> (respondendo uma mensagem) ou reagir <id> <emoji>");
        const alvo = await message.channel.messages.fetch(alvoId).catch(() => null);
        if (!alvo) return temp(message.channel, "Mensagem não encontrada.");
        await alvo.react(emoji);
        await message.delete().catch(() => {});
    },

    // ===== Administração do servidor =====
    servidor: async message => {
        const g = message.guild;
        const dono = await g.fetchOwner().catch(() => null);
        const embed = new EmbedBuilder()
            .setTitle(`🏰 ${g.name}`)
            .setColor(COR)
            .addFields(
                { name: "ID", value: g.id, inline: true },
                { name: "Dono", value: dono ? dono.user.tag : "Desconhecido", inline: true },
                { name: "Membros", value: String(g.memberCount), inline: true },
                { name: "Canais", value: String(g.channels.cache.size), inline: true },
                { name: "Cargos", value: String(g.roles.cache.size - 1), inline: true },
                { name: "Criado em", value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true }
            );
        const icone = g.iconURL({ size: 256 });
        if (icone) embed.setThumbnail(icone);
        return message.reply({ embeds: [embed] });
    },

    iconserver: async (message, args) => {
        const url = message.attachments.first()?.url || args[0];
        if (!url) return uso(message, "iconserver (anexe uma imagem ou envie um link)");
        await message.guild.setIcon(url);
        return message.reply("🖼️ Ícone do servidor atualizado.");
    },

    nomeserver: async (message, args, resto) => {
        const nome = resto.slice(0, 100);
        if (!nome) return uso(message, "nomeServer novo nome");
        await message.guild.setName(nome);
        return message.reply(`✏️ Nome do servidor alterado para **${nome}**`);
    },

    banner: async (message, args) => {
        const url = message.attachments.first()?.url || args[0];
        if (!url) return uso(message, "banner (anexe uma imagem ou envie um link)");
        try {
            await message.guild.setBanner(url);
        } catch {
            return message.reply("❌ Não consegui trocar o banner. O servidor precisa de boost nível 2 e o link precisa ser uma imagem.");
        }
        return message.reply("🎌 Banner do servidor atualizado.");
    },

    invites: async message => {
        const convites = await message.guild.invites.fetch();
        if (!convites.size) return message.reply("Nenhum convite ativo.");
        const linhas = convites.map(c =>
            `\`${c.code}\` • ${c.inviter?.tag ?? "desconhecido"} • usos: ${c.uses ?? 0}${c.maxUses ? `/${c.maxUses}` : ""}`
        );
        const embed = new EmbedBuilder()
            .setTitle(`🔗 Convites ativos (${convites.size})`)
            .setDescription(linhas.join("\n").slice(0, 4000))
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    criaconvite: async (message, args) => {
        const usos = Math.min(Math.max(parseInt(args[0], 10) || 0, 0), 100); // 0 = sem limite
        const convite = await message.channel.createInvite({ maxAge: 0, maxUses: usos });
        return message.reply(`🔗 Convite criado (${usos ? `${usos} uso(s)` : "sem limite"}): ${convite.url}`);
    },

    deletaconvite: async (message, args) => {
        const codigo = (args[0] || "").split("/").pop();
        if (!codigo) return uso(message, "deletaconvite <código ou link>");
        await message.guild.invites.delete(codigo);
        return message.reply(`🗑️ Convite \`${codigo}\` deletado.`);
    },

    lockserver: async message => {
        await message.reply("🔒 Servidor travado: membros não conseguem enviar mensagens nos canais de texto.");
        await travarCanais(message.guild, true);
        addLog(`[LOCKSERVER] por ${message.author.tag}`);
    },

    unlockserver: async message => {
        await travarCanais(message.guild, false);
        addLog(`[UNLOCKSERVER] por ${message.author.tag}`);
        return message.reply("🔓 Servidor destravado.");
    },

    // ===== Proteção e auditoria =====
    logs: message => {
        if (!logs.length) return message.reply("Nenhum log ainda.");
        return message.reply("```\n" + logs.join("\n").slice(-1800) + "\n```");
    },

    antispam: (message, args) => alternar(message, args, "antispam"),
    antiraid: (message, args) => alternar(message, args, "antiraid"),
    antiinvite: (message, args) => alternar(message, args, "antiinvite"),

    lockdown: async (message, args) => {
        const opcao = (args[0] || "").toLowerCase();
        if (opcao !== "on" && opcao !== "off") return uso(message, "lockdown on|off");
        const cfg = config(message.guild.id);
        cfg.lockdown = opcao === "on";
        addLog(`[LOCKDOWN] ${cfg.lockdown ? "ativado" : "desativado"} por ${message.author.tag}`);

        if (cfg.lockdown) {
            await message.reply("🚨 Lockdown ativado: canais travados e novas entradas serão expulsas.");
            return travarCanais(message.guild, true);
        }
        await travarCanais(message.guild, false);
        return message.reply("✅ Lockdown desativado.");
    },

    warn: async (message, args, resto) => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "warn @usuário [motivo]");
        const motivo = semMencao(resto).slice(0, 300) || "Sem motivo";
        const chave = `${message.guild.id}:${user.id}`;
        const lista = avisos.get(chave) || [];
        lista.push({ motivo, por: message.author.tag, data: Date.now() });
        avisos.set(chave, lista);
        addLog(`[WARN] ${user.tag} (total: ${lista.length})`);
        return message.reply(`⚠️ ${user.tag} recebeu um aviso (total: **${lista.length}**). Motivo: ${motivo}`);
    },

    warnings: async message => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "warnings @usuário");
        const lista = avisos.get(`${message.guild.id}:${user.id}`) || [];
        if (!lista.length) return message.reply(`${user.tag} não tem avisos.`);
        const linhas = lista.map((a, i) =>
            `**${i + 1}.** ${a.motivo} • <t:${Math.floor(a.data / 1000)}:d> • por ${a.por}`
        );
        const embed = new EmbedBuilder()
            .setTitle(`⚠️ Avisos de ${user.tag} (${lista.length})`)
            .setDescription(linhas.join("\n").slice(0, 4000))
            .setColor(COR_AVISO);
        return message.reply({ embeds: [embed] });
    },

    clearwarn: async message => {
        const user = message.mentions.users.first();
        if (!user) return uso(message, "clearwarn @usuário");
        avisos.delete(`${message.guild.id}:${user.id}`);
        return message.reply(`✅ Avisos de ${user.tag} limpos.`);
    },

    // ===== Pesquisas =====
    google: pesquisa("google", "🔍", "Google", "https://www.google.com/search?q="),
    imagens: pesquisa("imagens", "🖼️", "Imagens", "https://www.google.com/search?tbm=isch&q="),
    videos: pesquisa("videos", "🎬", "Vídeos", "https://www.google.com/search?tbm=vid&q="),
    noticias: pesquisa("noticias", "📰", "Notícias", "https://www.google.com/search?tbm=nws&q="),
    maps: pesquisa("maps", "🗺️", "Maps", "https://www.google.com/maps/search/?api=1&query="),
    youtube: pesquisa("youtube", "▶️", "YouTube", "https://www.youtube.com/results?search_query="),
};

client.on("ready", () => {
    addLog("Bot online");
});

client.on("guildMemberAdd", async membro => {
    try {
        const cfg = config(membro.guild.id);
        const agora = Date.now();
        const entradas = (entradasRecentes.get(membro.guild.id) || []).filter(t => agora - t < RAID.janela);
        entradas.push(agora);
        entradasRecentes.set(membro.guild.id, entradas);

        if (cfg.antiraid && !cfg.lockdown && entradas.length >= RAID.entradas) {
            cfg.lockdown = true;
            await travarCanais(membro.guild, true);
            addLog(`[ANTIRAID] ${entradas.length} entradas em pouco tempo: lockdown ativado`);
        }

        if (cfg.lockdown) {
            await membro.kick("Lockdown ativo").catch(() => {});
            addLog(`[LOCKDOWN] ${membro.user.tag} expulso ao entrar`);
        }
    } catch (err) {
        addLog("[ERRO] " + err.message);
    }
});

client.on("messageCreate", async message => {
    try {
        if (message.author.bot) return;

        if (message.guild && await aplicarProtecoes(message)) return;

        if (!message.content.startsWith(PREFIX)) return;

        const now = Date.now();
        if (cooldown.has(message.author.id)) {
            if (now - cooldown.get(message.author.id) < 2000) return;
        }
        cooldown.set(message.author.id, now);

        const corpo = message.content.slice(PREFIX.length).trim();
        const primeiro = corpo.split(/\s+/)[0];
        const cmd = primeiro.toLowerCase();
        const resto = corpo.slice(primeiro.length).trim();
        const args = resto ? resto.split(/\s+/) : [];

        if (!cmd || !Object.hasOwn(comandos, cmd)) return;

        if (!PUBLICOS.has(cmd) && !ehDono(message)) return message.reply("Erro interno.");

        await comandos[cmd](message, args, resto);
    } catch (err) {
        addLog("[CRASH] " + err.message);
        message.reply("Erro interno.").catch(() => {});
    }
});

client.login(process.env.TOKEN);

require("http").createServer(() => {}).listen(process.env.PORT || 3000);
  await comandos[cmd](message, args, resto);
    } catch (err) {
        addLog("[CRASH] " + err.message);
        message.reply("Erro interno.").catch(() => {});
    }
});

client.login(process.env.TOKEN);

require("http").createServer(() => {}).listen(process.env.PORT || 3000);

// Imagem da miniatura do painel, embutida aqui para não precisar de arquivo separado
const PAINEL_IMAGEM = Buffer.from(`
iVBORw0KGgoAAAANSUhEUgAAAHYAAAB2CAAAAAA4zDjNAAAtmUlEQVR42lW7V6xmWXbft8/eJ+fz
nfPlfGPduvdWVVdXdZjumekeTuAwSBwGCRyZY5oGaAgKEETYhgDbgAG/+NHwk0XYFkgZkClqJFH0
YAJnunt6OlV15XTr5i/H830n5+AHztD0etmPP6yFtV72Hz9sG/y8lFmYBikSmQWv+BHAiRgnM5gn
eAwoHG28/ur9cRRecz3ALiiUWyQf2kw2YnMf4akbwW9dvfPvl9GV/974l5+qv3f7X8u//cH6778o
HBW/PuBmVSBxHwqk9//821/A4M/fkhl/9Qt1hoQ5wv3S1zSShVIRcwORDMjEhOxw6h09WREvT9Kw
Vy3qsRQf+eByXFstcDh0FZfK6mUkQGeocizm5WyLLN1auYmo5TAQbIG/RGS/dOufbf4ch1QAAACv
vf2Xy2eL7S3F8yOU6/jB0oEoQqRrZKRH8VYIaLiWzKCQLLLiakJ7q6h8EkjkZYGM5t3OWD6ZbHHC
EQ0Kb66O/L3KR5XGMyWFHrWLS7HCsvnj6mJvCF7X4QwAAAAOAADgm187w7Bs/QGGb1436j1r/ZLJ
MuQyOJdCkcw4MpfA0he5GCih3bhcq9FMrKFUmqKN2aC+PrYVYf3wdx0po1OqiuM5Ck2f4Vxmycok
TRFEfK951Hru3viLjb//Xx//Tbff+mUp+mFCdzkzdmeTqfBbN08ZapoSUaKqcUjFOknrvnp+YvvH
K9J9iIiktL/CbwbzUv69FYQORcOIpa8Tac/ubjnPyNb1UUGl9lyfpxmSJEE+8nTV6t+4I736f77X
cH6O/dav5fjq8TqzrEzmEi7i+fHDYdKVqHIRxIFnxHngAMV3MRDEURq4N8pMjuInPzkzJ0aFZPhv
38hckmPYLeYYMhv05bRxYyqWchCFEp9QeWSHKxRnj24t0MG/ef6lf+6fAIAD8OVvrdD409rQCzGp
lRzD/bewR1efDkYg59Kcq3RClGCCdHDJVp7YBsYz4YdD1U2lCuK2Pb8Ibety/90czFYXb7K3e2C+
Ja5TXMFJkOIyWUZ5jIeLoq58cGB6m//6/Gtvn76XIoCD1h8mxKLPlQEkgYCdSYVrb6LX/2SJpYCI
8sw5P0lBRpYNZ8q8cT7xYQgJXkG1klHbciK+qQOWfqA0v/BjmjQumkE/WBFqi8i0zHbqKSoLYZrY
uLtufLgNnPaP9K/dfvDH7D/7d8dI/Y1mBS1NeQyzChbOUrL2avnk5M4CQoxAKf9GMSqI/E6JrW2H
r1QFmeEIvMQD7lXkiPg5WZuaJcUJD8kcR7Pshvlw2bkWTvl24JE4QSDLIXnwZGKZTztkXv5wdvP2
97+7+y+uBPfQF7COz0gTD5UifxVLErv5FeJHL6MFxlIZTsEGWBMVycsrW+CrmzN9+4CRS1wmlJ5b
+aWjwRXXzGOZwiraJJbxDSIc0XvWXbxuGenUFxuNmgChsJRKRQWjf7x+u/2XD770O9T//sc4+rab
STnl9jnJfJrTPMbf/tr8Tp/OYhomgBcsVyZJDoEq59CtckgCeDY+tyPdq2QZ0c4BowCCI9ZCUetT
edJeH/FadIkVJP9xf/eaioUOpPluhcGI+LP0HfIH61+/3f+fnr7yj9AfGY/bXFh2XyLyBZsGllPZ
f+EUdvilGwKCZLAQUNmC0YJVcNe+HlffJy8HmGRiryZW54pNbWZeVT7JW66ioUdj6tDskVBkvc3m
4h7zdXk5s3wC6iGFvPBO8Hb4XumXaz/8E+4f/V4J/Zdu5aO0qICkbt5BJS3jWG9VvtnJR/M4TfPY
Mx1ftzLCWR4v8y+VhFNHN3LkioWE3WpY9NO3apkb46zlN7T5GDTL9oopwmbNKtSfX+a9I9/V9T/7
KOOBahwYT3b3rT+7/+a/KD/8l+jdvBjd0XJ2X3z8hJSvpe0UZ7zx6Pg0ybMsjaM0toPICtHMfuX1
rqNx96JJCHnFKzT8TQDc77whjKR8ynG4UjsfcFvjC15rduNVtGs89U/X8eAonX4/bNVV8sl4v3Hx
l+xvvzr+k//lGH1zQXWY/6CXkPtgCBq7y4HjWMspMGdpCEGUZiCPwkwjslXtOtRlsnBxYlVLClfj
cK50CRpTbmu378Zx7hVK/FnQSWLlWiU1ByGh47J4mHwyvf7VsHmjQo3iNvnT8a038L/64/tiG/0+
AeVk/d4ST3WaPzww3bo/h63cavEpheMwiVkGkUVmZokqOErOV40n7qFi5oqbqPYx0Zz3WiSKgnHM
BQXFHWSCethOF0GJNPpNftbWgvm23BRZlrqgZg/Krxce/avHm1e/8Q/RVyRqku2NP1s2ZeE3DqaT
RNKaJO4kXKtarlZFUiqrBTG1cdLr7Hp/dTTltGCNIncCoRFkXt8Dy2BXAThzORE6pbNlZ6MdLAht
7Bqw5tffvL75ahlVZid+cfjQutma/Pn9yq3f/HvlSxybyxxkfsVMLvfEm8lPJi6kYeilyGarIcW4
KYYnmRthSQRV7BrNXfns1/d+BKKc5TjTIxYxuQiee7Xb25fTRw6++/bjrUpqMNpoCnet+O1NDHDb
tr/G5OEVuMtnPzzVXj2gs5/98D30X5ziu4LVrEclKq9T8Qy1NalTw4McEnhkqi1M3q3i1ZZY2GYj
XCJaJemNhk3e/BIXtfZYnnCT/ez7z2SJ4ZfPl02yvJd6nLZ8dgGqJUmM43zpRtHCkZKWnV6cELvv
ttOH3/vRUwr9D2iNeBKrEPflva6nbm/ubP7GW3vFzKsQvVUe9GJm6SahCSLTDFYzDC5b3UKgHQp4
6hy8VRUt1jTOeo+TUqcNV0Zhh7Ax1XxwPzjYIFxzjhlmhqSxWY7JJ8/Ug/qGdf+zp4bItNEflfCX
gAnz8ll+a1sttTZyvajakZq15JWoGCGXL21Pd0vEim0xVLdTvsrguKpgHjWzeLlwsLnwJGzw0sXq
22DweslO6t6Dh8JXbpQtY5bAdbUZr2a1cmAS+11aP7+zYNvtV17ZRf8ttuZhKIp4Vtys4qnn04Gu
rhdleqCDyMc5AAoYWSwkeREntGoFFkIv0zicdy6E2Us7EIiD6zVeJE5GCGLFJm6J9MsP0m++GjsP
L8pkWq2sVi6+k2VpN+s9dThuY+crmxo9x2mSIjMWyqOzbQ5LPNvzudSo01bSW0PdEtplXrXnSMl9
GU/wGuc6S6ogq6lJ8Vll3T8SiuVyfccZ3Fs80OWN1M3U8QiPSs77D82GZkA6cgKsKMyWrhMJV/Ay
yMnT4Pmz+zgNtUBlR5cvCrdK9jzN2dN1maFR74cDbBHVMPKmFGbpU3ozNSoFlxSxJSsMXMp4Wa49
DndeDkzrJxW1W9rf7L1YcYyIgXBCXJuA1Lz3yi+BFY3Y3PRbi4zmWBngySpdcJ867grH6bxMEWl+
HvzyzvLUtXTNOw7e3lHFPPPsHL9SieZZ520wXFEeFoN5Mk+IHGdMmxUmWZbjAoLYnRDuX68RvEIA
Cy+dja8s4VS5kWuVOcXjMyeLzQuiVQaZP5svKVLQ1nKEof8RowgIcuZayxk8pq2PPs6rD4/crLUV
O3Hqbt8W+xdrQaUCBZovZxMn44HDYJO0bQG5knDbCl1iyzvicT/yQ0Xy/Y3nF608D/KMhyPYQPk0
Qd6pRaTefJV6dpbEDpURlopnaU4AvFxYzZK8aLrOGEL+wfPN3bff3Tk7PjnZv1b1UFgkcYQ5DZzM
lpGqrkMxC9a1JBNxHOaJg/jVjOydx6mGz8+HyJB3xWDKXU7ekIRcSxY2oSoShREYKUYpwElhzsa4
hbEYAFn/EmS6+yFarN0eGwVPLwavyVvtg9mpT+2JeaFafjwdvtYV9OgoaLNDAV+Q9nqejPUi8vAK
aatExrm9ph88U0swaikrIYnKXWYQy9AoFjSRABDL/RREOQxivLLAXzR4kMfL2ey5MSKeNZaJZIal
xHTuPedvXt374no8s3DIiywmCwqWuW2DUdj5BWuCxP6hl8KHk4ymC4WqnItBUxjgvCA7pJLzRn4z
x9zAAmXMGLUKYVGK4NoCEchsKCMF72+CeLyqKkurNw7SpUWwgkpOLDunWPepdn2/i9Z6fmyDfvtV
IcacvNLiwoYBS5OZs23aebVD8yUc53gTszY3/Lg2xtZUg7HHUmE9g2meEZQG5+sMWA4hkARuLpmW
w3r4oQKSubU7I3/9zg901WcEUJVfjMMc8aI/8+60u83yZsNYh+duE48dttTveVQXWh8OGe96Qphy
0RGrkx4bjJbbZV1qhPHqSV/fd1bUYMbQQ2ErJ1+h1jHmTxYed8BkXELZOGWj/zkJEyyzf7D8Vf7F
hA2hJtaciyDBqmUOWak3OXp6dn5kR9bayWNsLqV6pgrs4Om/JfYKfHlHdfnYGkxWTBn1WcbPlGcX
B6khwSCJ44zRvSL2ctmzMKnCi6VinicRpMBUQAB/wUd56eRh78v55i9NCNmvNfVTgnc3rqZZDzER
yJyTE1hVSSg607dq+YNaXWJAXr/W4rdDc3Q3wAVJa8KME8LjVdVeOjP71i4GMoLwfIsuBbrk3jvl
yNoWLrU2DN8fwGITpiW0CdyfkAP8xs1o6a1XjR1ufUTKk/IBr7kXIS6hIAUAoHlvvjKMi5n78PTx
eX+WiEjG7cXJj6ftw0alA8zIvJvyZYmQ8OwzsYTnqnv6HFbleErvVYtUP06TOb2axAntz+tFY9bD
5QfHevK10HnuxX696YufPPU3Se1rLcvnqmYVDROQw27t2At1Z336+EvSx4TOvaCImGKT5Oor5XLl
EnuMrTcBTIurppZwXwr+PSaRUibVm3ycUPq9YqteW00CYE9HBY4cjHd59qMh+u++/9DL6dr4zjMO
xBvjzy99sYk23m3fTh4ZG83xIkMEe0saRBhI0tCr1BLQesv78bDSi956tbIPPvvzh6RFd0RfLuXL
FqY7wpv1tAf4YqkrhmmpuTgbHqc7ZZkDZsa3F9Yskycfvaehg3tBhU5ewc+dLjadXPT86j7mNVO7
OflYvbk4CjF6U8yCdRUGGZGmIO0NMvqLyrT41lcO1OmT/3RefbMtGs8+tZwLuRySuPdJ9A77yYzh
1CoJp1FXi6Zny6nXrEimVED5zGBWpQfvfhUR3nWa2ecLka/b00uPsLq7lld84s97fGf6uU0AWgx0
mrzuOdg2R9LgfGaNel/f7zEbLx9dBtWvvFm6fP7ywZy++6n/ZibI+qdPhWX86v41FWPFuceoVZhl
Uz/CCUwVlrFeb1Z/enpDQPxuuVxIjf5xkhyNXGGldOe6GD7UsLhj37sg8YRNHW2XpJdhUiuQSm99
WKoET195d/FBw63s3KIffnhyPFEEnlxPrE0FpMvc+gm5RS6SgkKYEK2FBpWLaSjHq8ElIVbTJXea
vcOhfw78Bnt5s0tH4eOlyNpNLp80T41yQ87PHyQ8SkHUaJgRXBAh1UZg/la7tNcwhspbaXmzlH36
3mrFz+rXhGyHgzEJuWQ8WMFscPqptyukLgMWrlKhQ8sh7OksaI6w/r2nyfD4CfoDPMsb+1cVQQrT
CKiHcSDHzOfNXYLrPZ3xeEpBUSKmZnXtS4DG7INaqUuQZcvItlPwyX+KOjt1f+MKA72AbGtSDR8N
HYIGs4nn8RuMZWPI0pmiCwhTV/luSSmZNx1ivDFFf1RYEHyNffrkKcUwfqfrECoz6nc2lu78GGNz
ok0gpamzHc8tHVDC5ToV1T5fKOhDdPlV0sfLjRIlhQWJP07qHRrkni9gEc+FWO5QZXtF8oRnrSae
78QiXqM4mhTA+URoo/88ycS5NlhejGug8OrO+/HmyNWz1vboRQioIKE2In9DO3stnpcLZNcf52Rv
kjAL7Ip/dPFp7bcKvU+UPRvJvptDk5acQOEdWsNBV5kxGpFzwBNY04j7PYFcOdH4rIr/6UNDKF5B
r9OVB0n8k4dbb4tmvbk6Gp96pQSnsvmlhTZzM39VUku0/vYACQd4fmHx++KZE50nDoT6i2fjw05x
do9qFMJAwNemIBE0hslshFEiGuXNHIM4ifvrwItFMEmNiTcxPhra2eW3Ef4r4Ll4+R9P5ghwahQY
azMu51Y0txaW3xXX8d4GWhWT156Jg62983ET1Q++4J0vZ4NMWvWc5x8ZX9ivYScv+U0DU7wjsOHH
YuRAyo5qwXHxagpY3ybiCZJDp5CYQvP01CH/wfmwh7aY57ujB2s68uL0gucGcT1Q+fk6IEw3B5pg
y9eJ55SyfzfWNX4aSk5W4TfytL/wl6PEd6en9xdXr9dbg88cmeAw/ZxUUp6HEZNM/UzepDkqw3mK
xCCdhpKM9BjS69nwC19H3zp6uPEowhFVb16c74v3HQuq2mQh0ouE9vPbjWSr9thqHzxY8gF5fXRM
KAa90X4a+fqyRvCNdx6pH//sXv3GxpWuOXOaYEZZuu31k3Jx692/+3YrwmUSBhkbAgmzI2U9VmmP
sg3bRjcG4t0RE2zQAk5KIXn0nDjY0V8EZQ4TKY/mtQK+Z9roMD+Gi7fTuBkoQRBzkyniDWPVgvTg
23fHg7PZ44291t4VLeVKWzf291597XBvtyWvnoW1Ak3SGI4Va6CVLqmSHSqUixF9VGbQSUzZ4ZXV
KVOVZuvn4JXDkeMxGcERtsewFSnu2usrnVEU2OX916KAxScvGkHUE+TDRJ53S9IoXE68//tnhtAo
Xbm+v1GW0Or4zl+9PyULBC0hiBhqBUpZhEELF1YJ6drv7sq4k/jFyNrK73LXp47vpiJpn2/HczOz
yUPh8fCqy3Rq9otE/OJn8dGbp2JHw8cb7lrpitG3d/9iSm80q/z31hMzHz3+U4riKIqCQzdL/Zj4
zt/h5PSZvyNmCYBnMrHEtofnajDWfn/jR19ARcpMeAfuVVpirb8gH2CblXAk5XnueDHJrTJ1WdUq
kyFeuxwfLvKjzpqty5WCgLHC9g+9Wy9RR9HzeY6n+1+ITs3g+ZmO3Kz+zj/5zm3vyVpkClNTti6k
EgRcVorpOHBe+yX3h/MACYDGV5W186vXVVBTz1+C7tfbF5cRW/B1IsuzhFs83mlIPwr44ohcBMNA
4QQ7KamPdt+2v3LwYc/bVRYYJl/Zo6zXahPyxiqML/VVJGxud6ksXuR530BQlRVkauOs6HLvND7/
bsB/hraWDJEvxY7XVGBKjiOP2djik7Pz241jb0tecMW6f7eywx9ZXfJJfl75UESNSMyTtsRdrfpx
4dlrsRBON5nXOk128z8rLr6mDsPYGc1Id+C4AWKau+WxAlaMCDPBMLRbgzsXcpxQqLrm3VVKeNhz
ov9smCcWkugyEQ3R6/wxuPplLN2tZ+8Ht+qRvTF1izD5uHvaJQKxy9HMGnouNr0Kg8ZkK3pdMxub
7b3KO4fl9pVXhEV5U6k0Wko8PIfTpErjzsKO99ij4RDFmS+ilAEGgRKh3Ib7/F1KM6yGpKtXOoAs
Rj2W4bsU5SnHP9vds4IrR4N/cH36426PXOFzkQlIxdYL4Cu5Qn3zg7cN53XxWBEHzlYly4LS6xVv
PkR4lEIn2+7yuKevxK2XVmCVpiZRHyIRcxNi47qfRxkOf7Imn9jqTcSWa5ExD6OJQE2F7jV1cPmj
Ew6CbX119cbWpzD8VW88J2YYXyS6/qObyjL78nc7u9OVdWfx/PzJh0+lze1U2SSExWMIzM6OQiK4
0Bv05fq45ZMwrfE52l+mha/W0HrcNN77qFj3LyOhyOYvwkIURyK1uF4f9UqboR2PzjFe3NUfCjdf
K9m9mwdtp1vJifJkM3Bq0rRc+lfk2xCXPxJ3uBvffLWa40JjE6WlRqej5Pfuzc5jeerKhRBQl+Ru
bG6jGtq8OTs5ha9QnpXvS8zc4EpPPlEr1gUzvKgRT+RC8dP57fNP2/XhR4bLXbk204qtpx4ZVpSc
wpFRQfhE2Dmuqi8++GVqrRzztTRaOCKXs7LYkPURzcOSP07tn2Y0lcsTvgZxwsQR35jfXyREdyd6
xnw58bh7ef02e7nD0PUAy5jCYtTqNcY/vc4Yb/29bxWZcjZXC0v218DloRSwBEEqF7sXmusdxGXz
k7MbJTp7VBPpRjykpdOPe4+ezp1jIzy6k7R3C67/sgzyqBicFXY+RGWDCJD2Vc43Q0Z83nx2Qpdq
uXE+LTbrGt8nOovezvN2415Y2VEzpaIWWwKuilkx9iUREhii5NENXS1eVjX3L571xYsW82kaP01p
j0hDz0iwOLNWq0Wrq9WbF8WTD5QF4EVYShFneaxwKJGDUXD9fqV+J8XtGZXdo5UQonF/9zCcDuTL
7A0yTVMgsDEt5CHPeYxy0qJRjhBGiWbVQVdkWkUnlrYx3lizb+Jxsu6KHMNqhNrJJ0HVBiWG4I4L
D9//py1n9GZJQzROErdZ28uGe4bNrBYa3QpfWihLM9cgiaj0jnQ5TO1lJxwgwSUVIsKlHPAQVxcV
hCAGMVwgFWIOca4yumC+Gj6VLze/WprhSj8qWisCX8GdogE3VQTAC76lWTd2W/9OqyFWFnbikLWW
+/5AYF/kKGLkfkqHgM70XDvr8fmUw8eV+kd7/e/O9bIUEwyJcRBnLQVBDAKAYRikJArLMuyM3y41
9OEYOz8jr+ELuZpZIZQKy2nFGEoUfaJ34wldlm78ySXayl6jp0rTR6lZ98FolVDOkONCsYXcBtZL
pM8fAx0DEsETX/vNHfeiT5OIJQAB8WENwb/OQ/MM5Ekw/8wQn3UbBSpsBVhc6yYE5Rbl2YkBPJlB
1N0+fKEtK7VBi8PfbKLrh8dhg57I7Fm9GC0LkMhgxtMpwousR4oz6nZs4nySdTZ7W9Xytes36vQi
Z0mICMQQ2F+noqkHktM/GzVl98jVx0OOpgKx3vHtBKQRwenHkBYEZnX/43dMCkHpfofKeXTjVIwx
v5bNBWqCQboYuAKX5hKu49UUVFfegXTGlwvZYSHCtmjAIYzUeIJAGGRz4udhLIb78x6uFDM7+RSU
//QTuKGfIM3SOWyFGC/n/LRYCpWrySNBW4mF//UGxyRIxUgM3tBO4xbmxIqmu0zuMxFG8GZyJX0Z
NVTHjziRwMPui3KRhDgBAY5DhAD6BRVgGPL7LdvGNe9xVEsuaTD3jNgw1wy/HJFc4AWP7QKbNZjH
9zmT/JWfHjUFdNtxXn+ldyQWViBNBWxhKpEo52u5uURVzEWFfGmPqT0+WKsvay06pQgMxyGOYRgG
/qbyaHBWEw2WC9L8VsnO6Cq5GKArcBRYCxfqebn4ecgbedlnBouHxLvkjxQk1t4uDy69EjCBUrLy
BGIdYc55nJyQAGlDvYn1QlqChLASwo7AIkQgiP42E2SpefmwOBZwJiSpiL9+TcsYuTs/G4kly0eW
V9AwsOn9ZLx6qt8UuSL2uVz9U/S7O+W7n3FNx1EI0scGlsbLthL6IkN7oRaNln5IwSkrhLUxtb6i
EhBHGPxrah4FWeIn8Xry3mB/dacmJYiO4svdWLtCLfkOHeKJohUloSQoeMZf8U3mSipICMQvEw0/
OHp2lrMBLMaNs3Ue43TjPlMYBFTFsfj8ZVIZ5l8Gg/OG5wvs+LRNI/iL8ebJ5bwWrkjwzFZuGWPr
2S4socIy/eybVqzeFBEC1rkRBdZJeMjNgCy2CA2AsIiGr388xND+y35Ztsh2yvr4bCG3uAuqvphA
TcHQ7NJGKEwphVgk3aq7Lo52FPS3BuxtSmq1LKNQEDAcemQxDYgY05nCgpFBZLshT+C0tq89ei9s
F4frwDQZOWYrk1yjEay00pGUYJ3Edi2yLPe8V+DLuFAAJGUuaSaG6UzS8qNKVVl4HxabLPwFFYMi
ieMQnP0f37wgCGq88ULVCQVbb5xUNctNkOVkMaaySUbXD96s+8o1jT7YBAUGQd630dtByNOo0J7H
8IjrBM/8vfCiQsEKEwzMOKNrZQh5yK3PtJtjqvdBrMh/wwUYhoF8+YFR8nGgRzvLftEwSpzF9q4k
wwQvErabBBFDeRF+9l5/dBF7EZZAyFVFnkffgKV6Zmu0Ey0Zzhktu1fWQoNMstTsrWmlVUgUeQS5
9cA/7ASq890zieHh3zod/y6KjzfP5bVIaeNcnzJCXHb1nXJvIYgcmYUmKXGdIkA0Mzu/mDg0v6Bk
UpDQ62XcT0V2JU5FyhuF+5vhzsF0XfTt2ZqsNGimBddmilhrTr1BOpL+8vu+IFJ/03B6Nk+iYs/g
FW+yL38iYQu5nnMDQaHtS5sqc1KFx2FGVa9I+O6G4J5O8TzTMYVF76gckAvzEJZm525a3peKLXO4
ypbGOilqIksxnI/WjBLZ09uS4Snh4uO7kBfRz7fZ+1nFIFG+HpaiuMNTJ8AIqwIlDjKpS19YeYwg
QbLIcvtOIGuVbms9dClbjDD0+zNYc07wrm8sHLd5mFf2zL4RD7g9KRRFUNC8nCEWkZp7Lsup4501
Hw9+PMYJFmE5BtKeleIVNxQNi4hEupodYWHI0TS2YsPiQfDSX5+s/OnR2Tjm8IBWAF42xxnJBRBd
8Y1Jyiu4/ywgxM1Ku7WC7mOMal7dF3TApnGOhxE1p4qSd7GvLfZWhe2BP/ssDIBHw2zxmGZDTEaJ
4sU+UKGqDKcRQfh87lI+YKvJfG0Pj408s61lSHv29NI+PcGIyEbNJpO35JN7K9yvddXa1cUF8i6x
HXWtbiiTpWtrjINVTLNGRw5bJsbp7OCeW9pMP1+f2aPl6GWqGdGG6Mplc2GRNK2QS9cC3CrmWdK+
GJBSW0iagklrXsaDIe46xE7Z1rE76A8UnJ2fDhGhdGtCq/v4THCeUNq+soq4CurPKBYTqUBZpUAV
TvjOSgjv2O61Q0YVlg/eP+2OmAyKKtfAHEXuncj5qlRa9gNubRfYAFtkFQHna4JckaCAS6UKw3c7
7VfeOrw7Qd/W++MXXq1W3q65oto/Epr6eWv3muxPChrrznwTiaTHoTEqcFZMpLZiMkqzLXg1pcan
7YWSpWIDISEDNDEdSHLCFLLJsgymnDC1szhNQOZHFLSzkMswZ5m5jscF1V2k+pfL+q1ypemNqo2X
R81y7DPdPTWOUq+gEHA0QD5eMRCAZrV+jomari62dru0Pd0MqSbnT7RhctU3gEq4JfrFvEN5vJas
Q84zmIKMzwPoullgsdV4rWQLGvlWKcLRzStoW263rm2AWZyXyWAtlZj1cGNTgDFViu1G28cIN+bl
LK9exqxiRVklFk1HqxCGZ3p+VdPOA8DJXOIhDqc5ypjDwsSswKFd9fpKKWNkBguxzM1gQkUBoEYa
39iRK0SO/iuxew07nsVMueA6Rc4lZycbXdyHAiJ9qyHiKg6Rx3BxDMxAXBVONtI8XFOJHZvAj+sV
5km51tsSNTznMkzyZuR6bMm8mi/ySCdkgcJo3AdKPMOyGSkH440yhlF5RKDvlNHFeZQ1Vc/iaJAL
xufsdSxh8gRnqFXA0dkGb2S+S5bmFEdYlfyyIK+f514ilSHhU2EFnCc8J6aAQY7r6bRQyNNI3Civ
dWgNOBnSEOdpJAiujYRkFWU4mwcAeeideNpjDtWIjnS+5EXiswd7tShSco8iMz49M1ltQ8pmlgQw
T1qzwcbDuDSJhWmTlxxWdo7xa8PjK2s2fugxx9b0mCfxBj5yVguFX0NqZqlyArjUYJTAFaAVSn1e
DfoomaFv6NGNDScjIqRSeJKcvofKuBT6iM1TSiKMU5Pc2pSySPdkewUrprv50KodXFOGOmKklHHH
SVu/IJP0TkSM89H7Y5X00Ya41C0v93DeWgRIiMLcNWlozSlSsJBpphUUob9ba1G6SWJILhVI1310
qqlCJbczEmAkJFV8tATFRgufLl3GpL36rBMPbhXxbdtddnm2UoO6VbcWScyUfJR5Yz2h2DzMiuX1
fd0d4WW37ysEDm0nw2wHkoBKHUe4oa3RHyjoAvAu1iqSArhYn6SovilCyTUowkloIMSznk4U6lX7
ccQYTlPoVVccL3iwxK5KrSxf4e6xbJ/RpZgHMazhY1dW7DyyUjmdeZZRrpszrRxSxMLhsbUoriT1
nNmHZ+h3kxwjgVDVEAGWy7yXpFVFIsgkScI4iQjeXwnZtO9UW+hi7dJOA0vgxU4lxACahP7Ym9pk
sNxY9UGMZ5V6tQrxtUNjIE3YnOTpyCR53AtZGnP8KMQM1iPn5HYj0dGv6UDF3U45xTivB/G+F1fY
EhkwsmfmuYvFi/zqHj4YTNIqvEwJN9uM01Qvl9QnfS00JAVmBB9QRK9HZ8xuRVCEWBTci7yiAIx0
Qt7sYXU8xlLAp5dQ9tccbTQUF1DoGyDpQSJNBRLzR8hcMUZR4XAaxTQFCCpcGxhobWjQM/1KatgF
jJCpfBJEj4crCm0ChmNBTCdEyV04uCOoChwr2xjKYsRoosyRgpjqGAMVjo9TByMIWnIDNKU59HtV
2YiR7wKWsIf0es1bYoHAhCxgGELiSSr0Y1CqalUmDbvrFSauKxoW66FSrShKHc182uKYFAoqFc/0
VYbLwbghNpggRzHRaVU7dTaxRjpVFWnezYodLR41VCzA0X9j7LV4s8TqoDA6q8fHeAaUThxRchzx
AiEXJYwxgKwUCkJGiEV9XrarhVIQfLFb2G2uPM4wmF2mWYnC7WKc6idnHgzYUooX6IhFS1+V6BIX
uNMXZ2RLkSWKUU741/nIF9EfLsG2ggkEkSZzr+BOlHTRvjk1eSrO8AywPB/jcoJwmpdUCuO0MrkM
tjo8OlEJOJ+joio0Q7hbJXNWUoVCNDq5XCE5RzzCBMz3FkEuyzZJ9E/nc6YoZ/5qdrDF6VmA/g4z
K/IgxUS0cJXIMOlM33ot0/2EQVYI85xgdEgMh/oAKxYIvNw0Fmm83yHmpxt9r1mKJS3oo4nekdcG
pbL1HWZ21jsLyBTJacAyOmTsvEokvDDtTwIXB1aszvszvYe+EyUvhy/0JyMmnAIqfGyWgqi7g5kA
JjgKMJEx799/ev/uo89Wp06jaPeVSm/K74kF/9mhTOHki/kRPqbpJU3DPA4zoXvQSS+enXgyRfM4
LGAARxRPY7BAGXrRuMDcLANM6KN/bGY/e3HZ+/jx1DgWtOSzcTM7rt6UWeBjGg9p56d/fufpo+na
MeQXnzqfDKRuAYRPmZYG7nLYyeJMP6Hz+e3N1PY3MSQEHs+XD65xL89mOskDrEBmihATWrSuarCQ
1ZKVbfLFNsaiW/2LT7zUc7x4scRl6+RY6UyZbpEXJBIlFx/84JOh6UZY8fouu+6Pqzv1HHRE/TlP
EKP3WhXKi9wUvrHLFoTojNlgcMa3orhwY5d88XxsW4abYGHIJp7MuVlBxcjtSjD07LiHoeIl7POZ
VJDSdToOhOkxc5hdVDdJjrYe/eij8wXXLNVvvnFzH9wV1P23a5h7tl7Ws6cUi130b5WQs867hyJA
oIDps5YCLISn7oq9seM8mzBbrYqQ5SSJYn8VETmXzJyutnhiCAm6siZaWdx9HRJVZITRaBJTmger
gnfv+8dWKjewBCMRGY3ff3Rr6xXl4x98Nu5rMqHMKa5w/OJqvTd45ZDOXP+FryFjyJapJOTkxeP4
jUMlmq2KzUpFNhMVRg3sCJOEccMPd+jRMYXeXcfbiVoLSLHA5TSO6Va2xTzXl5fHAaF0VH/NMFRK
aPKa/Hrj/vc+Pp9i15qS1qI+VuTgc3BT3NkoZsdTPyZCX8uPJ2oepLi7ful3S9cKx0cepalkmLCV
RsFcp0m3xAGjDtZzdFWOjJYSGkVmUtG8hDH1kG3a4/mSk2Kazeh2tVDZ1ORSjDnpT+97hFBUO6KG
MuppIaKfo8MaY0xRJBTChMUwcv3IycbHsbh4QXY7ne3gQcz4MLNx1s/U0QzsOIUyPaPac/Sbrjje
iaVSDdbkWUSGqeUk9a6r5wgyTEZQfLVZoMX4ww8HUrWjlaBsQa6apoIKP70trU6agntOkQKR4jAO
w7WuB+uQVoruRGppTHGzMTqDeUzlZorn9NIzNmhSlKllB/2hxzVxX22QgugaWQ4QZ5sJm8UsjlXw
WCySvArj+TPyG69t1JQ3Nw/39Z6fj4vFjFLuHqjrUXVVgkCMYy4aOZER7VBL5lA1B5JGygjjK214
MmST8Sod2sXsaLHD5wTwMBy9UyXtWPVCiXVhghs8zmjG0OWhT2R5pQBimTOzvn/YUHm826ipJbay
9+yknA0lmV1/+pXlidjOeHxNs+M+HmdMG2GdfEqerfbVdSzCFCmV3F5GxQLNlKbOXNQ3JXgE4SX6
nTJtmCLyyKWzzKHnLfhWezE2nNiHflJnIEf4p/XOeZA0tisKzYp4k+aOH2lWqpjq9MlbUe+1gE29
1LETJcfLTMzK1HQsFyuCbdEcwCGeK2i+1FJOZhXpfL5HzMBi4qKDA8ThxC7T9xhnkmRxlNDlV4Xz
heNZGBwXOlF4XtuhcqUhShzCECRYZHWijyzcpYnyHeeNcLqrm4ThS0LEakkgMHYooWnlGspoC4gI
y0xfqlqfEOyKLYiPQ5btIZf8KzT9Qgc2CnyIyBhn/SDEY6fYbneDoenqQ9/wpaWyE/nbW2IeADN6
dHLmVe3aAfmxzMaOtfFZcJNcI4CxhJP7IsIgDMdOpc1P9GpiBpDFUnuQ0myx8EJXQpLizgZXoyD2
/xKp/d+yMoGQtrlzX/WJMhmFEWC3a3w0d92lOUkK7ZyJNYXkiOx40SnXiZdOaftQeu/GhftFLf0I
Y/y2skAcIOq4Kwq951oJigqcGYlHY2acGRaGB3xbvBxVTun2vXlHedH5vwyk6oPDGFdKEseHQ4LL
MBV/MY+50pU9eW2GXorcggITwFI4PpG4RbrOudNrz2tXXfsb+1leXZ2/aDGwyyCeQwRMJpNKlefj
pFzo66Uk5ICPhCWQQCTUg8/5KJd703rzPz4BSAWX+aGooIzAYxciPSNw4PnLqKBsvsbNrXgd26mw
Xk19xhmVRFAt5hhfMyb49eevopVfuvI59TIK+K6qcakXn7rlNsHKbJbktL3I8wIZ4cRspWAuxQnl
4SIpjicbH3z4187IMXzLj+jcSxtGsFFYipX1Op88T6j46m1sagQ+zNrt6PyRQU5doLGsWFwtAZcW
H0RF/Kx27bvMhJiuSmJk9V7W2rKmZvMw7ftl+mKZhGXNdyS9R6pZWHAxYrUyiEf3fmHIHIVXCYgZ
AWOvGCwlYhvxgpP666S7ofGrfgTWxN5mXhD52QYOcRwzgtZA4IcyT7hEh7pT/mjEjz/qwai42WRc
23Zz3+a4XMPOgpKYpEgnS0LoYZygaXfVp5f/n4b0bPFFE8SrKUMOfSHy6smUrcYJbj4cvfbr19jj
Rys2prFcpYBCe/mMXWXtInVy+1IIS2m69fgS9PtHufWE2YSTOHKQGGcK7UKCAdMQYCTwCXtNCY5P
iqHwvdHftp8u3i9V/IDK/YQkIRmHWZYmkZuaS7Yjd39n5/kHM46ojQNslMn2mZpBlUIXccDEUZZX
r3wcsYtkEWLh8bG+CGiYxlgaZDiJK8QpXycI0KdKccQyvnf5b/r/P+kKWD/FmERYedv4vNRcpIUw
lsjREgPSluC03vrt7Qf/4VJtb9TVvlVxX5CcCDF3/PrHnQuV7fnX7k5EV5rzs1HZe3JuPn8Qexew
4K1FBcf7MRSYS1IIEjrNf/i/GT//vft/AXfrANleCVjfAAAAAElFTkSuQmCC
`, "base64");
