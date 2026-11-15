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

// Painel de comandos ;P
function montarMenu(guild) {
    const embed = new EmbedBuilder()
        .setTitle("✦ PAINEL DE COMANDOS")
        .setDescription(
            "Bem-vindo ao painel de administração!\n\n" +
            "Aqui estão os comandos disponíveis no servidor.\n" +
            "Use o prefixo `!` antes de cada comando."
        )
        .setColor(COR)
        .addFields(
            { name: "💻 SISTEMA", value: "`!menu` • `!ping` • `!status` • `!restart`" },
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

    // Miniatura = ícone do servidor (muda sozinha se o ícone do servidor mudar)
    const icone = guild?.iconURL({ size: 256 });
    if (icone) embed.setThumbnail(icone);
    return embed;
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
