/*
 * SERVIDOR WATERVENDOR IOT V5 - FRANQUIA MASTER & ANTI-SLEEP
 * Integração: Google Sheets (Cache), Mercado Pago Dinâmico, MQTT e Auto-Ping.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios'); // Necessário para o Anti-Sleep
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const mqtt = require('mqtt');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();
app.use(bodyParser.json());
app.use(cors());

// ==================================================================
// --- 1. CONFIGURAÇÕES E VALIDAÇÕES DE AMBIENTE
// ==================================================================
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SERVER_URL = process.env.SERVER_URL; // Ex: https://watervendor-server.onrender.com

if (!SPREADSHEET_ID || !SERVER_URL) {
    console.error("❌ ERRO CRÍTICO: Variáveis GOOGLE_SPREADSHEET_ID ou SERVER_URL em falta!");
}

// Autenticação com a Service Account do Google
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/sheets'],
});

// ==================================================================
// --- 2. SISTEMA DE MEMÓRIA CACHE (ANTI-LENTIDÃO)
// ==================================================================
let CACHE_USUARIOS = [];
let CACHE_MAQUINAS = {};
let CACHE_TOKENS = {};

async function atualizarMemoriaCache() {
    try {
        console.log("⏳ Atualizando memória cache a partir do Google Sheets...");
        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo();

        const abaUsuarios = doc.sheetsByTitle['usuarios'];
        const linhasUsuarios = await abaUsuarios.getRows();
        CACHE_USUARIOS = linhasUsuarios.map(row => ({
            nome_dono: row.get('nome_dono'),
            login: row.get('login'),
            senha: row.get('senha')
        }));

        const abaMaquinas = doc.sheetsByTitle['maquinas_precos'];
        const linhasMaquinas = await abaMaquinas.getRows();
        const novoCacheMaquinas = {};
        linhasMaquinas.forEach(row => {
            const id = row.get('id_maquina');
            novoCacheMaquinas[id] = {
                id_maquina: id,
                nome_dono: row.get('nome_dono'),
                preco_5l: parseFloat(row.get('preco_5l').replace(',', '.')),
                preco_10l: parseFloat(row.get('preco_10l').replace(',', '.')),
                preco_20l: parseFloat(row.get('preco_20l').replace(',', '.'))
            };
        });
        CACHE_MAQUINAS = novoCacheMaquinas;

        const abaTokens = doc.sheetsByTitle['tokens_mp'];
        const linhasTokens = await abaTokens.getRows();
        const novoCacheTokens = {};
        linhasTokens.forEach(row => {
            novoCacheTokens[row.get('nome_dono')] = row.get('token_mp');
        });
        CACHE_TOKENS = novoCacheTokens;

        console.log("✅ Cache do sistema atualizado com sucesso!");
    } catch (error) {
        console.error("❌ Erro ao atualizar o cache:", error.message);
    }
}

// Primeira carga ao iniciar e atualização a cada 5 minutos
atualizarMemoriaCache();
setInterval(atualizarMemoriaCache, 5 * 60 * 1000);

// ==================================================================
// --- 3. CONEXÃO MQTT (HIVEMQ FINAIS DO ESP32)
// ==================================================================
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || "mqtts://d848ae40758c4732b9333f823b832326.s1.eu.hivemq.cloud:8883", {
    username: process.env.MQTT_USERNAME || "watervendor01",
    password: process.env.MQTT_PASSWORD || "Water2025",
    rejectUnauthorized: false 
});

mqttClient.on('connect', () => console.log("📡 Conectado ao Broker MQTT com sucesso."));
mqttClient.on('error', (err) => console.error("❌ Erro MQTT:", err.message));

// ==================================================================
// --- 4. ROTA DO CLIENTE (PÁGINA DO QR CODE)
// ==================================================================
app.get('/maquina/:id_maquina', (req, res) => {
    const { id_maquina } = req.params;
    const dadosMaquina = CACHE_MAQUINAS[id_maquina];

    if (!dadosMaquina) {
        return res.status(404).send("<h1>Máquina não encontrada no sistema.</h1>");
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="pt">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Comprar Água</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; background: #f4f7f6; padding: 20px; color: #333; }
                .container { max-width: 400px; margin: auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
                h1 { color: #0077b6; margin-bottom: 5px; }
                .btn { display: block; width: 100%; padding: 15px; margin: 15px 0; font-size: 18px; font-weight: bold; color: white; background: #0096c7; border: none; border-radius: 8px; cursor: pointer; transition: 0.2s; }
                .btn:hover { background: #0077b6; }
                .price { font-size: 14px; display: block; font-weight: normal; opacity: 0.9; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Pureza & Saúde</h1>
                <p>Máquina <strong>${id_maquina.toUpperCase()}</strong></p>
                <button class="btn" onclick="pagar(5)">5 Litros <span class="price">R$ ${dadosMaquina.preco_5l.toFixed(2)}</span></button>
                <button class="btn" onclick="pagar(10)">10 Litros <span class="price">R$ ${dadosMaquina.preco_10l.toFixed(2)}</span></button>
                <button class="btn" onclick="pagar(20)">20 Litros <span class="price">R$ ${dadosMaquina.preco_20l.toFixed(2)}</span></button>
            </div>
            <script>
                async function pagar(volume) {
                    const res = await fetch('/criar_pagamento', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ id_maquina: '${id_maquina}', volume: volume })
                    });
                    const dados = await res.json();
                    if(dados.link_pagamento) window.location.href = dados.link_pagamento;
                    else alert('Erro ao gerar pagamento.');
                }
            </script>
        </body>
        </html>
    `);
});

// ==================================================================
// --- 5. GERAÇÃO DINÂMICA DE PAGAMENTO (MERCADO PAGO)
// ==================================================================
app.post('/criar_pagamento', async (req, res) => {
    try {
        const { id_maquina, volume } = req.body;
        const dadosMaquina = CACHE_MAQUINAS[id_maquina];
        if (!dadosMaquina) return res.status(404).json({ error: "Máquina inválida." });

        let precoFinal = volume === 5 ? dadosMaquina.preco_5l : (volume === 10 ? dadosMaquina.preco_10l : dadosMaquina.preco_20l);
        const tokenDono = CACHE_TOKENS[dadosMaquina.nome_dono];
        
        if (!tokenDono) return res.status(500).json({ error: "Conta financeira ausente." });

        const mpClient = new MercadoPagoConfig({ accessToken: tokenDono });
        const preference = new Preference(mpClient);

        // A URL do webhook recebe a máquina via Query Param
        const webhookInteligente = `${SERVER_URL}/webhook?maquina=${id_maquina}`;

        const mpRes = await preference.create({
            body: {
                items: [{ title: `Água ${volume}L - ${id_maquina}`, quantity: 1, unit_price: precoFinal }],
                payer: { email: `cliente_${Date.now()}@watervendor.com` },
                payment_methods: { excluded_payment_types: [{ id: "ticket" }], installments: 1 },
                notification_url: webhookInteligente,
                external_reference: `${id_maquina}|${volume}`
            }
        });

        res.json({ status: "ok", link_pagamento: mpRes.init_point });
    } catch (error) {
        console.error("Erro MP:", error);
        res.status(500).json({ error: "Falha interna" });
    }
});

// ==================================================================
// --- 6. WEBHOOK INTELIGENTE (LIBERAÇÃO)
// ==================================================================
app.post('/webhook', async (req, res) => {
    const idPagamento = req.query.id || req.query['data.id'] || req.body.id;
    const idMaquinaPredefinida = req.query.maquina; 

    if (idPagamento && idMaquinaPredefinida) {
        const dadosMaquina = CACHE_MAQUINAS[idMaquinaPredefinida];
        if (dadosMaquina) {
            try {
                const tokenDono = CACHE_TOKENS[dadosMaquina.nome_dono];
                const mpClient = new MercadoPagoConfig({ accessToken: tokenDono });
                const payment = new Payment(mpClient);
                
                const info = await payment.get({ id: idPagamento });

                if (info && info.status === 'approved') {
                    const [maquina, volumeStr] = info.external_reference.split('|');
                    const volume = parseInt(volumeStr);

                    // Comunica com o ESP32 exatamente no tópico daquela máquina
                    const topico = `watervendor/${maquina}/comandos`;
                    const payload = JSON.stringify({ msg: volume });

                    mqttClient.publish(topico, payload, { qos: 1 });
                    console.log(`💰 APROVADO: Liberados ${volume}L na máquina ${maquina}`);
                }
            } catch (error) {
                console.error(`Erro webhook da máquina ${idMaquinaPredefinida}:`, error.message);
            }
        }
    }
    res.status(200).send("OK");
});

// ==================================================================
// --- 7. PAINEL DO FRANQUEADO E EMERGÊNCIA
// ==================================================================
app.post('/api/liberacao_manual', (req, res) => {
    const { login, senha, id_maquina, volume } = req.body;
    const usuarioValido = CACHE_USUARIOS.find(u => u.login === login && u.senha === senha);
    
    if (!usuarioValido) return res.status(401).json({ error: "Não autorizado." });

    const topico = `watervendor/${id_maquina}/comandos`;
    mqttClient.publish(topico, JSON.stringify({ msg: parseInt(volume) }), { qos: 1 });
    console.log(`🚨 MANUAL: ${usuarioValido.nome_dono} acionou ${volume}L na máquina ${id_maquina}`);
    
    res.json({ success: true, message: "Comando enviado!" });
});

// ==================================================================
// --- 8. SISTEMA ANTI-SLEEP INTERNO (AUTO-PING)
// ==================================================================
app.get('/', (req, res) => res.send('Servidor WaterVendor Master V5 Online 🚀'));

setInterval(() => {
    if (SERVER_URL) {
        axios.get(SERVER_URL)
            .then(() => console.log(`⏰ [Anti-Sleep] Auto-ping realizado com sucesso.`))
            .catch((error) => console.error(`⚠️ [Anti-Sleep] Falha:`, error.message));
    }
}, 14 * 60 * 1000); // Executa a cada 14 minutos

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Master V5 a rodar na porta ${PORT}`));
