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
    "google", "imagens", "videos", "noticias", "maps", "youtube",
    "ajuda", "lembrete",
    "saldo", "daily", "transferir", "loja", "comprar", "rank",
    "porcentagem", "ship", "8ball", "ticket"
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
const moedas = new Map();            // "guildId:userId" -> saldo em 💶
const ultimoGanho = new Map();       // "guildId:userId" -> última vez que ganhou 💶 por conversar
const ultimoDaily = new Map();       // "guildId:userId" -> última vez que pegou o !daily
const mensagensCount = new Map();    // "guildId:userId" -> total de mensagens (para o !rank)
const lojas = new Map();             // guildId -> Map(roleId -> preço)
const autoCargos = new Map();        // guildId -> roleId dado a quem entra
const filtros = new Map();           // guildId -> Set de palavras proibidas

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

// "10m", "2h", "1d", "30s" -> duração em milissegundos (ou null se inválido)
function parseDuracao(texto) {
    const m = /^(\d+)\s*(s|seg|segundos?|m|min|minutos?|h|horas?|d|dias?)$/i.exec((texto || "").trim());
    if (!m) return null;
    const valor = parseInt(m[1], 10);
    const unidade = m[2][0].toLowerCase();
    const multiplicadores = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return valor * multiplicadores[unidade];
}

// Emojis numerados usados pela !enquete
const NUMEROS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// Uso e descrição de cada comando, usado pela !ajuda
const AJUDA = {
    menu: ["menu", "Mostra o painel com todos os comandos."],
    ia: ["ia", "Comando reservado (atualmente indisponível)."],
    ping: ["ping", "Mostra a latência do bot e da API do Discord."],
    status: ["status", "Mostra se o bot está online, o ping e o tempo ligado."],
    restart: ["restart", "Reinicia o bot. (dono)"],
    ban: ["ban @usuário [motivo]", "Bane um usuário do servidor. (dono)"],
    unban: ["unban <id>", "Remove o banimento de um usuário pelo ID. (dono)"],
    kick: ["kick @usuário [motivo]", "Expulsa um usuário do servidor. (dono)"],
    mute: ["mute @usuário [minutos]", "Silencia (timeout) um usuário por um tempo. (dono)"],
    unmute: ["unmute @usuário", "Remove o silêncio (timeout) de um usuário. (dono)"],
    nick: ["nick @usuário novo apelido", "Troca o apelido de um usuário. (dono)"],
    limparapelido: ["limparapelido @usuário", "Remove o apelido de um usuário. (dono)"],
    avatar: ["avatar [@usuário]", "Mostra o avatar de um usuário (ou o seu)."],
    userinfo: ["userinfo [@usuário]", "Mostra informações de um usuário (ou de você)."],
    roleinfo: ["roleinfo [@usuário]", "Lista os cargos de um usuário (ou os seus)."],
    criarcargo: ["criarcargo <nome> [#cor]", "Cria um novo cargo no servidor. (dono)"],
    excluircargo: ["excluircargo @cargo", "Exclui um cargo do servidor. (dono)"],
    editarnomecargo: ["editarnomecargo @cargo novo nome", "Renomeia um cargo. (dono)"],
    corcargo: ["corcargo @cargo #RRGGBB", "Troca a cor de um cargo. (dono)"],
    adicionarperm: ["adicionarperm @cargo Permissão", "Adiciona uma permissão a um cargo. (dono)"],
    removerperm: ["removerperm @cargo Permissão", "Remove uma permissão de um cargo. (dono)"],
    darcargo: ["darcargo @usuário @cargo", "Dá um cargo a um usuário. (dono)"],
    retirarcargo: ["retirarcargo @usuário @cargo", "Remove um cargo de um usuário. (dono)"],
    listarcargos: ["listarcargos", "Lista todos os cargos do servidor."],
    infocargo: ["infocargo @cargo", "Mostra detalhes de um cargo."],
    criarcanal: ["criarcanal <nome>", "Cria um canal de texto. (dono)"],
    criarvoz: ["criarvoz <nome>", "Cria um canal de voz. (dono)"],
    apagarcanal: ["apagarcanal [#canal]", "Apaga um canal (o atual, se não citar outro). (dono)"],
    renomearcanal: ["renomearcanal #canal novo-nome", "Renomeia um canal. (dono)"],
    topico: ["topico <texto>", "Define o tópico do canal atual. (dono)"],
    trancar: ["trancar", "Impede @everyone de enviar mensagens no canal atual. (dono)"],
    destrancar: ["destrancar", "Libera @everyone para enviar mensagens no canal atual. (dono)"],
    slowmode: ["slowmode <0 a 21600>", "Define o modo lento do canal, em segundos. (dono)"],
    nsfw: ["nsfw", "Ativa ou desativa a marcação NSFW do canal atual. (dono)"],
    limpar: ["limpar <1 a 100>", "Apaga uma quantidade de mensagens do canal. (dono)"],
    limparuser: ["limparuser @usuário [quantidade]", "Apaga mensagens recentes de um usuário. (dono)"],
    fixar: ["fixar (respondendo) ou fixar <id>", "Fixa uma mensagem no canal. (dono)"],
    desafixar: ["desafixar (respondendo) ou desafixar <id>", "Remove a fixação de uma mensagem. (dono)"],
    anunciar: ["anunciar [#canal] texto", "Envia um anúncio em embed. (dono)"],
    embed: ["embed Título | Descrição", "Envia uma mensagem em embed. (dono)"],
    say: ["say texto", "Faz o bot repetir o texto enviado. (dono)"],
    reagir: ["reagir <emoji> (respondendo) ou reagir <id> <emoji>", "Reage com um emoji em uma mensagem. (dono)"],
    servidor: ["servidor", "Mostra informações do servidor."],
    iconserver: ["iconserver (anexe uma imagem ou link)", "Troca o ícone do servidor. (dono)"],
    nomeserver: ["nomeServer novo nome", "Troca o nome do servidor. (dono)"],
    banner: ["banner (anexe uma imagem ou link)", "Troca o banner do servidor (precisa de boost nível 2). (dono)"],
    invites: ["invites", "Lista os convites ativos do servidor. (dono)"],
    criaconvite: ["criaconvite [usos]", "Cria um convite para o canal atual. (dono)"],
    deletaconvite: ["deletaconvite <código ou link>", "Apaga um convite do servidor. (dono)"],
    lockserver: ["lockserver", "Trava todos os canais de texto do servidor. (dono)"],
    unlockserver: ["unlockserver", "Destrava todos os canais de texto do servidor. (dono)"],
    logs: ["logs", "Mostra as últimas ações registradas pelo bot. (dono)"],
    antispam: ["antispam [on|off]", "Liga/desliga a proteção automática contra spam. (dono)"],
    antiraid: ["antiraid [on|off]", "Liga/desliga a proteção automática contra raid. (dono)"],
    antiinvite: ["antiinvite [on|off]", "Liga/desliga o bloqueio automático de convites. (dono)"],
    lockdown: ["lockdown on|off", "Ativa/desativa o modo lockdown do servidor. (dono)"],
    warn: ["warn @usuário [motivo]", "Dá um aviso a um usuário. (dono)"],
    warnings: ["warnings @usuário", "Mostra os avisos de um usuário. (dono)"],
    clearwarn: ["clearwarn @usuário", "Limpa os avisos de um usuário. (dono)"],
    google: ["google <termo>", "Pesquisa um termo no Google."],
    imagens: ["imagens <termo>", "Pesquisa imagens no Google."],
    videos: ["videos <termo>", "Pesquisa vídeos no Google."],
    noticias: ["noticias <termo>", "Pesquisa notícias no Google."],
    maps: ["maps <termo>", "Pesquisa um local no Google Maps."],
    youtube: ["youtube <termo>", "Pesquisa um vídeo no YouTube."],
    ajuda: ["ajuda <comando>", "Mostra o uso e a explicação de um comando."],
    lembrete: ["lembrete <tempo ex: 10m> <texto>", "Avisa você mesmo depois do tempo informado (ex: 30s, 10m, 2h, 1d)."],
    enquete: ["enquete pergunta | opção 1 | opção 2 [| ...]", "Cria uma votação com reações numeradas (até 10 opções). (dono)"],
    sorteio: ["sorteio (respondendo) [emoji] ou sorteio <id> [emoji]", "Sorteia um vencedor entre quem reagiu a uma mensagem. (dono)"],
    saldo: ["saldo [@usuário]", "Mostra quantas moedas 💶 você (ou alguém) tem."],
    daily: ["daily", "Pega 100 💶 uma vez a cada 24 horas."],
    transferir: ["transferir @usuário valor", "Envia moedas 💶 para outra pessoa."],
    loja: ["loja", "Mostra os cargos à venda e o preço de cada um."],
    comprar: ["comprar @cargo", "Compra um cargo da loja usando moedas 💶."],
    addloja: ["addloja @cargo preço", "Coloca um cargo à venda na loja. (dono)"],
    removeloja: ["removeloja @cargo", "Tira um cargo da loja. (dono)"],
    rank: ["rank [moedas]", "Mostra o top 10 de mensagens (ou de moedas, com 'moedas')."],
    autocargo: ["autocargo @cargo | autocargo off", "Define o cargo que quem entrar no servidor recebe. (dono)"],
    porcentagem: ["porcentagem <algo>", "Diz uma porcentagem aleatória para qualquer coisa."],
    ship: ["ship @usuário1 @usuário2", "Mostra a compatibilidade (em %) entre duas pessoas."],
    "8ball": ["8ball <pergunta>", "Responde uma pergunta de forma aleatória."],
    ticket: ["ticket", "Abre um canal privado com a staff."],
    filtro: ["filtro add|remover|lista [palavra]", "Gerencia as palavras bloqueadas. Mensagens com elas são apagadas. (dono)"],
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
    const proibidas = filtros.get(message.guild.id);
    if (proibidas && proibidas.size) {
        const palavras = message.content.toLowerCase().split(/[^\p{L}\p{N}]+/u);
        if (palavras.some(p => proibidas.has(p))) {
            await message.delete().catch(() => {});
            addLog(`[FILTRO] mensagem de ${message.author.tag} apagada`);
            await temp(message.channel, `🚫 ${message.author}, essa mensagem tem uma palavra não permitida.`);
            return true;
        }
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

// ===== Economia, ranking e filtro =====

const chaveUser = (guildId, userId) => `${guildId}:${userId}`;

const moedasDe = (guildId, userId) => moedas.get(chaveUser(guildId, userId)) || 0;

function alterarMoedas(guildId, userId, delta) {
    const chave = chaveUser(guildId, userId);
    moedas.set(chave, (moedas.get(chave) || 0) + delta);
}

const lojaDe = guildId => {
    if (!lojas.has(guildId)) lojas.set(guildId, new Map());
    return lojas.get(guildId);
};

const filtroDe = guildId => {
    if (!filtros.has(guildId)) filtros.set(guildId, new Set());
    return filtros.get(guildId);
};

// Conta a mensagem para o !rank e dá de 1 a 3 💶 por conversar (no máximo uma vez a cada 60s)
function contarAtividade(message) {
    const chave = chaveUser(message.guild.id, message.author.id);
    mensagensCount.set(chave, (mensagensCount.get(chave) || 0) + 1);
    if (message.content.startsWith(PREFIX)) return;
    const agora = Date.now();
    if (agora - (ultimoGanho.get(chave) || 0) < 60000) return;
    ultimoGanho.set(chave, agora);
    alterarMoedas(message.guild.id, message.author.id, 1 + Math.floor(Math.random() * 3));
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
            { name: "💻 SISTEMA", value: "`!menu` • `!ping`\n`!status` • `!restart`" },
            { name: "🛡️ GERENCIAMENTO DE MEMBROS", value: "`!ban` • `!unban`\n`!kick` • `!mute`\n`!unmute` • `!nick`\n`!limparapelido` • `!avatar`\n`!userinfo` • `!roleinfo`" },
            { name: "🎭 GERENCIAMENTO DE CARGOS", value: "`!criarcargo` • `!excluircargo`\n`!editarnomecargo` • `!corcargo`\n`!adicionarperm` • `!removerperm`\n`!darcargo` • `!retirarcargo`\n`!listarcargos` • `!infocargo`\n`!autocargo`" },
            { name: "📁 GERENCIAMENTO DE CANAIS", value: "`!criarcanal` • `!criarvoz`\n`!apagarcanal` • `!renomearcanal`\n`!topico` • `!trancar`\n`!destrancar` • `!slowmode`\n`!nsfw`" },
            { name: "💬 GERENCIAMENTO DE MENSAGENS", value: "`!limpar` • `!limparuser`\n`!fixar` • `!desafixar`\n`!anunciar` • `!embed`\n`!say` • `!reagir`" },
            { name: "⚙️ ADMINISTRAÇÃO DO SERVIDOR", value: "`!servidor` • `!iconserver`\n`!nomeServer` • `!banner`\n`!invites` • `!criaconvite`\n`!deletaconvite` • `!lockserver`\n`!unlockserver`" },
            { name: "🔰 PROTEÇÃO E AUDITORIA", value: "`!logs` • `!antispam`\n`!antiraid` • `!antiinvite`\n`!warn` • `!warnings`\n`!clearwarn` • `!lockdown`\n`!filtro`" },
            { name: "🔎 PESQUISAS", value: "`!google` • `!imagens`\n`!videos` • `!noticias`\n`!maps` • `!youtube`" },
            { name: "💶 ECONOMIA", value: "`!saldo` • `!daily`\n`!transferir` • `!loja`\n`!comprar` • `!addloja`\n`!removeloja`" },
            { name: "🏆 RANKING", value: "`!rank` • `!rank moedas`" },
            { name: "🎲 DIVERSÃO", value: "`!porcentagem` • `!ship`\n`!8ball`" },
            { name: "🎉 EXTRAS", value: "`!ajuda` • `!lembrete`\n`!enquete` • `!sorteio`\n`!ticket`" }
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
    menu: message => message.reply({ embeds: [montarMenu(message.guild ?? client.guilds.cache.get(message.guildId))] }),

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

    // ===== Ajuda, lembretes, enquetes e sorteios =====
    ajuda: (message, args) => {
        const nome = (args[0] || "").toLowerCase();
        if (!nome) return uso(message, "ajuda <comando>");
        const info = AJUDA[nome];
        if (!info) return message.reply(`❌ Comando \`${nome}\` não existe. Use \`!menu\` para ver a lista.`);
        const [usoTxt, descricao] = info;
        const embed = new EmbedBuilder()
            .setTitle(`❔ Ajuda: !${nome}`)
            .setDescription(descricao)
            .addFields({ name: "Uso", value: `\`${PREFIX}${usoTxt}\`` })
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    lembrete: (message, args, resto) => {
        const duracaoMs = parseDuracao(args[0]);
        if (!duracaoMs) return uso(message, "lembrete <tempo ex: 10m> <texto>");
        if (duracaoMs < 5000 || duracaoMs > 7 * 86400000) {
            return message.reply("⏱️ Use um tempo entre 5 segundos e 7 dias (ex: 30s, 10m, 2h, 1d).");
        }
        const texto = resto.slice(args[0].length).trim();
        if (!texto) return uso(message, "lembrete <tempo ex: 10m> <texto>");

        const canal = message.channel;
        const autor = message.author;
        setTimeout(() => {
            canal.send(`⏰ ${autor}, lembrete: ${texto}`).catch(() => {});
        }, duracaoMs);

        return message.reply(`⏱️ Lembrete criado! Vou te avisar em **${args[0]}**: "${texto}"`);
    },

    enquete: async (message, args, resto) => {
        const partes = resto.split("|").map(p => p.trim()).filter(Boolean);
        const [pergunta, ...opcoes] = partes;
        if (!pergunta || opcoes.length < 2) return uso(message, "enquete pergunta | opção 1 | opção 2 [| ...]");
        if (opcoes.length > NUMEROS.length) return message.reply(`❌ Máximo de ${NUMEROS.length} opções.`);

        const linhas = opcoes.map((op, i) => `${NUMEROS[i]} ${op}`);
        const embed = new EmbedBuilder()
            .setTitle("🗳️ Enquete")
            .setDescription(`**${pergunta}**\n\n${linhas.join("\n")}`)
            .setColor(COR)
            .setFooter({ text: `Por ${message.author.tag}` })
            .setTimestamp();

        await message.delete().catch(() => {});
        const enviada = await message.channel.send({ embeds: [embed] });
        for (let i = 0; i < opcoes.length; i++) {
            await enviada.react(NUMEROS[i]);
        }
    },

    sorteio: async (message, args) => {
        const respondendo = message.reference?.messageId;
        const alvoId = respondendo || args[0];
        const emoji = respondendo ? args[0] : args[1];
        if (!alvoId) return uso(message, "sorteio (respondendo uma mensagem) [emoji] ou sorteio <id> [emoji]");

        const alvo = await message.channel.messages.fetch(alvoId).catch(() => null);
        if (!alvo) return temp(message.channel, "Mensagem não encontrada.");

        let reacao = emoji
            ? alvo.reactions.cache.get(emoji) ||
              alvo.reactions.cache.find(r => r.emoji.name === emoji || r.emoji.toString() === emoji)
            : alvo.reactions.cache.first();
        if (!reacao) return message.reply("Essa mensagem não tem reações" + (emoji ? ` com o emoji ${emoji}.` : "."));

        const usuarios = (await reacao.users.fetch()).filter(u => !u.bot);
        if (!usuarios.size) return message.reply("Ninguém reagiu (sem contar bots).");

        const vencedor = usuarios.random();
        addLog(`[SORTEIO] vencedor ${vencedor.tag}`);
        return message.reply(`🎉 Parabéns ${vencedor}! Você ganhou o sorteio.`);
    },
    // ===== Economia =====
    saldo: message => {
        const alvo = message.mentions.users.first() || message.author;
        return message.reply(`💶 ${alvo.username} tem **${moedasDe(message.guild.id, alvo.id)}** moedas.`);
    },

    daily: message => {
        const chave = chaveUser(message.guild.id, message.author.id);
        const agora = Date.now();
        const ultimo = ultimoDaily.get(chave);
        if (ultimo !== undefined && agora - ultimo < 86400000) {
            const minutos = Math.ceil((86400000 - (agora - ultimo)) / 60000);
            return message.reply(`⏳ Você já pegou o daily. Volte em ${Math.floor(minutos / 60)}h ${minutos % 60}min.`);
        }
        ultimoDaily.set(chave, agora);
        alterarMoedas(message.guild.id, message.author.id, 100);
        return message.reply(`🎁 Você recebeu **100** 💶! Saldo: **${moedasDe(message.guild.id, message.author.id)}**`);
    },

    transferir: async (message, args) => {
        const user = message.mentions.users.first();
        const numero = args.find(a => /^\d+$/.test(a));
        const valor = numero ? parseInt(numero, 10) : 0;
        if (!user || valor < 1) return uso(message, "transferir @usuário valor");
        if (user.bot || user.id === message.author.id) return message.reply("❌ Não dá para transferir para você mesmo nem para bots.");
        const saldo = moedasDe(message.guild.id, message.author.id);
        if (saldo < valor) return message.reply(`❌ Saldo insuficiente. Você tem **${saldo}** 💶.`);
        alterarMoedas(message.guild.id, message.author.id, -valor);
        alterarMoedas(message.guild.id, user.id, valor);
        return message.reply(`💸 ${message.author} enviou **${valor}** 💶 para ${user}.`);
    },

    loja: message => {
        const itens = lojaDe(message.guild.id);
        if (!itens.size) return message.reply("🏪 A loja está vazia.");
        const linhas = [...itens].map(([roleId, preco]) => {
            const cargo = message.guild.roles.cache.get(roleId);
            return `${cargo ? cargo.toString() : "(cargo apagado)"} • 💶 ${preco}`;
        });
        const embed = new EmbedBuilder()
            .setTitle("🏪 Loja de cargos")
            .setDescription(linhas.join("\n"))
            .setColor(COR)
            .setFooter({ text: "Use !comprar @cargo para comprar" });
        return message.reply({ embeds: [embed] });
    },

    comprar: async message => {
        const cargo = message.mentions.roles.first();
        if (!cargo) return uso(message, "comprar @cargo");
        const preco = lojaDe(message.guild.id).get(cargo.id);
        if (preco === undefined) return message.reply("❌ Esse cargo não está à venda.");
        const membro = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!membro) return message.reply("❌ Não encontrei você no servidor.");
        if (membro.roles.cache.has(cargo.id)) return message.reply(`ℹ️ Você já tem o cargo **${cargo.name}**.`);
        const saldo = moedasDe(message.guild.id, message.author.id);
        if (saldo < preco) return message.reply(`❌ Faltam **${preco - saldo}** 💶 para comprar **${cargo.name}**.`);
        try {
            await membro.roles.add(cargo);
        } catch {
            return message.reply("❌ Não consegui dar esse cargo. Confira se o bot pode gerenciar cargos e se o cargo dele está acima desse.");
        }
        alterarMoedas(message.guild.id, message.author.id, -preco);
        return message.reply(`✅ Você comprou **${cargo.name}** por ${preco} 💶!`);
    },

    addloja: (message, args) => {
        const cargo = message.mentions.roles.first();
        const numero = args.find(a => /^\d+$/.test(a));
        const preco = numero ? parseInt(numero, 10) : 0;
        if (!cargo || preco < 1) return uso(message, "addloja @cargo preço");
        lojaDe(message.guild.id).set(cargo.id, preco);
        return message.reply(`🏪 **${cargo.name}** está à venda por **${preco}** 💶.`);
    },

    removeloja: message => {
        const cargo = message.mentions.roles.first();
        if (!cargo) return uso(message, "removeloja @cargo");
        if (!lojaDe(message.guild.id).delete(cargo.id)) return message.reply("❌ Esse cargo não está na loja.");
        return message.reply(`🏪 **${cargo.name}** saiu da loja.`);
    },

    // ===== Ranking =====
    rank: (message, args) => {
        const porMoedas = (args[0] || "").toLowerCase() === "moedas";
        const fonte = porMoedas ? moedas : mensagensCount;
        const prefixo = `${message.guild.id}:`;
        const top = [...fonte]
            .filter(([chave, valor]) => chave.startsWith(prefixo) && valor > 0)
            .map(([chave, valor]) => [chave.slice(prefixo.length), valor])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        if (!top.length) return message.reply("Ainda não tem ninguém no ranking.");
        const medalhas = ["🥇", "🥈", "🥉"];
        const linhas = top.map(([userId, valor], i) =>
            `${medalhas[i] || `**${i + 1}.**`} <@${userId}> • ${porMoedas ? `💶 ${valor}` : `💬 ${valor} msgs`}`
        );
        const embed = new EmbedBuilder()
            .setTitle(porMoedas ? "🏆 Ranking de moedas" : "🏆 Ranking de mensagens")
            .setDescription(linhas.join("\n"))
            .setColor(COR);
        return message.reply({ embeds: [embed] });
    },

    // ===== Cargo automático =====
    autocargo: (message, args) => {
        const guildId = message.guild.id;
        if ((args[0] || "").toLowerCase() === "off") {
            autoCargos.delete(guildId);
            return message.reply("🎭 Cargo automático desativado.");
        }
        const cargo = message.mentions.roles.first();
        if (!cargo) {
            const atual = autoCargos.get(guildId);
            if (!atual) return message.reply("🎭 Nenhum cargo automático. Use `!autocargo @cargo` para definir.");
            const cargoAtual = message.guild.roles.cache.get(atual);
            return message.reply(`🎭 Cargo automático atual: ${cargoAtual ?? "(cargo apagado)"}. Use \`!autocargo off\` para desativar.`);
        }
        autoCargos.set(guildId, cargo.id);
        return message.reply(`🎭 Quem entrar no servidor vai receber **${cargo.name}** automaticamente.`);
    },

    // ===== Diversão =====
    porcentagem: (message, args, resto) => {
        if (!resto.trim()) return uso(message, "porcentagem <algo>");
        return message.reply(`🎲 ${resto.trim()}: **${Math.floor(Math.random() * 101)}%**`);
    },

    ship: message => {
        const usuarios = [...message.mentions.users.values()];
        if (usuarios.length < 2) return uso(message, "ship @usuário1 @usuário2");
        return message.reply(`💘 ${usuarios[0]} + ${usuarios[1]} = **${Math.floor(Math.random() * 101)}%** de compatibilidade`);
    },

    "8ball": (message, args, resto) => {
        if (!resto.trim()) return uso(message, "8ball <pergunta>");
        const respostas = ["Com certeza!", "Sem dúvida.", "Pode contar com isso.", "Talvez.", "Não sei dizer.", "Não conte com isso.", "Minha resposta é não.", "Muito duvidoso."];
        return message.reply(`🎱 ${respostas[Math.floor(Math.random() * respostas.length)]}`);
    },

    // ===== Comunidade =====
    ticket: async message => {
        const guild = message.guild;
        const nome = `ticket-${message.author.username}`
            .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
            .toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 90);
        const existente = guild.channels.cache.find(c => c.name === nome);
        if (existente) return message.reply(`🎫 Você já tem um ticket aberto: ${existente}`);
        const permissoes = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
        const canal = await guild.channels.create({
            name: nome,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: message.author.id, allow: permissoes },
                { id: OWNER_ID, allow: permissoes },
                { id: client.user.id, allow: [...permissoes, PermissionFlagsBits.ManageChannels] },
            ],
        });
        await canal.send(`🎫 ${message.author}, seu ticket foi aberto. A staff vai responder aqui.`);
        return message.reply(`✅ Ticket criado: ${canal}`);
    },

    // ===== Filtro de palavras =====
    filtro: (message, args) => {
        const sub = (args[0] || "").toLowerCase();
        const palavra = (args[1] || "").toLowerCase();
        const lista = filtroDe(message.guild.id);
        if (sub === "add" && palavra) {
            lista.add(palavra);
            return message.reply(`🚫 **${palavra}** adicionada ao filtro.`);
        }
        if (sub === "remover" && palavra) {
            if (!lista.delete(palavra)) return message.reply(`❌ **${palavra}** não está no filtro.`);
            return message.reply(`✅ **${palavra}** removida do filtro.`);
        }
        if (sub === "lista") {
            return message.reply(lista.size ? `🚫 Filtro: ${[...lista].map(p => `\`${p}\``).join(", ")}` : "🚫 O filtro está vazio.");
        }
        return uso(message, "filtro add|remover|lista [palavra]");
    },
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

        // Boas-vindas no canal "bem-vindo" (também acha o nome escrito em fonte estilizada)
        if (!cfg.lockdown) {
            const canal = membro.guild.channels.cache.find(c =>
                c.type === ChannelType.GuildText && c.name.normalize("NFKC").toLowerCase() === "bem-vindo"
            );
            if (canal) await canal.send(`👋 Bem-vindo(a) ao servidor, ${membro}!`).catch(() => {});
        }

        // Cargo automático, se o dono tiver definido um
        if (!cfg.lockdown && autoCargos.has(membro.guild.id)) {
            await membro.roles.add(autoCargos.get(membro.guild.id)).catch(() => {});
        }
    } catch (err) {
        addLog("[ERRO] " + err.message);
    }
});

client.on("messageCreate", async message => {
    try {
        if (message.author.bot) return;

        if (message.guild && await aplicarProtecoes(message)) return;
        if (message.guild) contarAtividade(message);

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

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
require("http").createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
}).listen(PORT, "0.0.0.0");

client.login(process.env.TOKEN);
