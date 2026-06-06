    // ── CONFIG ─────────────────────────────────────────────────────────────
    const GITHUB_IMG = "https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/";
    // ── WALLET DEL CONTRATO INTELIGENTE (recibe TODOS los pagos USDT) ─────
    const CONTRACT_WALLET = Object.freeze("EQD0iZjKNaeb8d6EJ7STxHI6wHZiv5mvB_ovgCJCuZMO1dQb");
    const WALLET = CONTRACT_WALLET;
    const PAYMENT_TYPES = Object.freeze({deposito:'DEPÓSITO',torneo:'TORNEO',entrenamiento:'ENTRENAMIENTO',retiro:'RETIRO'});
    function isValidTonAddress(addr){return typeof addr==='string' && /^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(addr.trim());}
    function getContractWallet(){return CONTRACT_WALLET;}
    function assertSecureContractFlow(tipo,address){
        const safeType = PAYMENT_TYPES[tipo] ? tipo : 'deposito';
        const expected = getContractWallet();
        if(!isValidTonAddress(expected)){throw new Error('Contrato FUTMUNDI inválido');}
        if(address !== expected){throw new Error(`Dirección no autorizada para ${PAYMENT_TYPES[safeType]}`);}
        return {tipo:safeType,address:expected};
    }
    async function buildContractTx(tipo,usdt){
        const flow = assertSecureContractFlow(tipo,getContractWallet());
        const amount = Number(usdt);
        if(!Number.isFinite(amount) || amount<=0){throw new Error('Monto inválido');}
        
        const userWallet = currentWalletAddr();
        if(!userWallet) throw new Error('Conecta tu wallet primero');

        const USDT_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
        let userJettonWallet = null;
        try {
            const res = await fetch(`https://tonapi.io/v2/accounts/${userWallet}/jettons/${USDT_MASTER}`);
            if(!res.ok) throw new Error('API error');
            const data = await res.json();
            if(data && data.wallet_address && data.wallet_address.address) {
                userJettonWallet = data.wallet_address.address;
                if(Number(data.balance) < amount * 1e6) {
                    throw new Error(`Saldo USDT insuficiente. Necesitas al menos ${amount} USDT.`);
                }
            } else {
                throw new Error('Jetton wallet no encontrada');
            }
        } catch(e) {
            console.error(e);
            throw new Error(e.message || 'Error al verificar saldo USDT. Asegúrate de tener Tether en tu wallet TON.');
        }

        if(typeof TonWeb === 'undefined') throw new Error('Librería TonWeb no cargada');
        const tonweb = new TonWeb();
        const jettonWalletContract = new TonWeb.token.ft.JettonWallet(tonweb.provider, { address: userJettonWallet });
        const body = await jettonWalletContract.createTransferBody({
            queryId: 0,
            jettonAmount: new TonWeb.utils.BN(Math.round(amount * 1e6)),
            toAddress: new TonWeb.utils.Address(flow.address),
            responseAddress: new TonWeb.utils.Address(userWallet),
            forwardAmount: TonWeb.utils.toNano('0.001'), 
            forwardPayload: new Uint8Array([])
        });
        const payloadBase64 = TonWeb.utils.bytesToBase64(await body.toBoc(false));
        const finalJettonAddress = new TonWeb.utils.Address(userJettonWallet).toString(true, true, true);

        return {
            validUntil: Math.floor(Date.now()/1000)+300,
            messages: [{
                address: finalJettonAddress,
                amount: TonWeb.utils.toNano('0.05').toString(),
                payload: payloadBase64
            }]
        };
    }
    function getWithdrawalOrder(cantidad,usdt,userWallet,feeUsdt){
        return Object.freeze({tipo:'retiro',contrato:getContractWallet(),walletDestino:userWallet,cantidadGemas:Number(cantidad),usdtNeto:Number(usdt),feeUsdt:Number(feeUsdt||0),feeDestino:getContractWallet(),fecha:new Date().toISOString()});
    }

    // ── TABLA OFICIAL DE COSTOS DE ENTRENAMIENTO (USDT) POR NFT ───────────
    // Mapeo: precio del NFT en gemas → costo de mantenimiento/entrenamiento en USDT
    const COSTO_ENTRENAMIENTO_USDT = {
        320:    1.00,
        1600:   5.00,
        3300:   10.30,
        6900:   21.50,
        9900:   30.90,
        12000:  37.50,
        18000:  56.25,
        75000:  234.30,
        150000: 468.70,
        255000: 796.80,
        420000: 1312.50,
        680000: 2125.00,
        999999: 3125.00,
    };
    function getCostoMantenimiento(precio){
        if(COSTO_ENTRENAMIENTO_USDT[precio]!=null) return COSTO_ENTRENAMIENTO_USDT[precio];
        // Fallback proporcional si aparece un precio no listado
        return Math.max(1, +(precio/320).toFixed(2));
    }

    // ── COSTO DE INSCRIPCIÓN AL TORNEO (USDT) ─────────────────────────────
    const COSTO_TORNEO_USDT = 10.00;
    const MAX_PER_PLAYER = 20;

    // ── GATE DEL TORNEO: requiere 100 usuarios con wallet + al menos 1 NFT ──
    const TORNEO_MIN_USUARIOS = 100;
    // TODO: reemplazar por tu endpoint real. Debe devolver JSON:
    //   { "walletUsers": <n>, "usersWithNFT": <n> }
    // walletUsers   = usuarios registrados con wallet conectada
    // usersWithNFT  = usuarios con al menos 1 NFT futbolista
    const TORNEO_STATS_ENDPOINT = "/api/futmundi/stats";

    async function fetchTorneoStats(){
        try{
            const r = await fetch(TORNEO_STATS_ENDPOINT, {cache:'no-store'});
            if(!r.ok) throw new Error('HTTP '+r.status);
            const d = await r.json();
            return {
                walletUsers: Number(d.walletUsers||0),
                usersWithNFT: Number(d.usersWithNFT||0)
            };
        }catch(e){
            console.warn('[torneo] stats no disponibles:', e);
            return null;
        }
    }

    async function actualizarGateTorneo(){
        const btn = document.getElementById('btn-inscribirme-torneo');
        const status = document.getElementById('torneo-gate-status');
        if(!btn || !status) return;

        const s = await fetchTorneoStats();
        if(!s){
            status.innerHTML = '⚠️ No se pudieron verificar los requisitos. Reintentando…';
            btn.disabled = true;
            btn.style.opacity = '0.45';
            btn.style.cursor = 'not-allowed';
            btn.textContent = '🔒 Inscripción bloqueada';
            return;
        }

        const elegibles = Math.min(s.walletUsers, s.usersWithNFT);
        const ok = elegibles >= TORNEO_MIN_USUARIOS;
        const pct = Math.min(100, Math.round(elegibles*100/TORNEO_MIN_USUARIOS));

        status.innerHTML =
            `👛 Wallets registradas: <strong style="color:var(--cyan)">${s.walletUsers}</strong><br>`+
            `⚽ Con al menos 1 NFT: <strong style="color:var(--green)">${s.usersWithNFT}</strong><br>`+
            `🎯 Progreso: <strong style="color:var(--gold)">${elegibles}/${TORNEO_MIN_USUARIOS}</strong> (${pct}%)`;

        if(ok){
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.textContent = '💳 Inscribirme — Pagar $10 USDT';
        }else{
            btn.disabled = true;
            btn.style.opacity = '0.45';
            btn.style.cursor = 'not-allowed';
            btn.textContent = `🔒 Faltan ${TORNEO_MIN_USUARIOS - elegibles} jugador(es)`;
        }
    }

    // Verificar al cargar y cada 30s
    document.addEventListener('DOMContentLoaded', ()=>{
        actualizarGateTorneo();
        setInterval(actualizarGateTorneo, 30000);
    });



    // ── CATÁLOGO DE JUGADORES ─────────────────────────────────────────────
    const PLAYERS = [
        { nombre:"Neymar Jr.",       pais:"Brasil",     flag:"🇧🇷", precio:320,    hp:72, pos:"Delantero",     color1:"#009c3b", color2:"#002776", img:"Neymar_320_gemass.png",          gemMin:8,     gemMax:15     },
        { nombre:"James Rodríguez",  pais:"Colombia",   flag:"🇨🇴", precio:1600,   hp:78, pos:"Mediocampista", color1:"#fcd116", color2:"#003087", img:"james_rodriguez_1600_gemas.png",  gemMin:35,    gemMax:60     },
        { nombre:"Alexis Sánchez",   pais:"Chile",      flag:"🇨🇱", precio:0,      hp:82, pos:"Delantero",     color1:"#d52b1e", color2:"#ffffff", img:"Alexis_3300_gemass.png",          gemMin:1,     gemMax:2,     free:true, freeBalones:2, freeGemasTotal:160, freeDias:90 },
        { nombre:"Harry Kane",       pais:"Inglaterra", flag:"🇬🇧", precio:6900,   hp:84, pos:"Delantero",     color1:"#ffffff", color2:"#cf142b", img:"harry_kane_6900_gemas.png",       gemMin:150,   gemMax:320    },
        { nombre:"Pedri",            pais:"España",     flag:"🇪🇸", precio:9900,   hp:86, pos:"Mediocampista", color1:"#c60b1e", color2:"#ffc400", img:"Pedri_9900_gemas.jpg",            gemMin:230,   gemMax:500    },
        { nombre:"Vinícius Jr.",     pais:"Brasil",     flag:"🇧🇷", precio:12000,  hp:88, pos:"Extremo",       color1:"#009c3b", color2:"#ffd700", img:"Vinicius_Jr_12000_gemas.jpg",     gemMin:325,   gemMax:750    },
        { nombre:"Rodri",            pais:"España",     flag:"🇪🇸", precio:18000,  hp:89, pos:"Pivote",        color1:"#c60b1e", color2:"#ffc400", img:"Rodri_18000_gemas.png",           gemMin:420,   gemMax:980    },
        { nombre:"Haaland",          pais:"Noruega",    flag:"🇳🇴", precio:75000,  hp:91, pos:"Delantero",     color1:"#ef2b2d", color2:"#ffffff", img:"Haaland_75000_gemas.jpg",         gemMin:2000,  gemMax:3800   },
        { nombre:"Mbappé",           pais:"Francia",    flag:"🇫🇷", precio:150000, hp:93, pos:"Extremo",       color1:"#002395", color2:"#ed2939", img:"mbappe_150000_gemas.png",         gemMin:4000,  gemMax:8100   },
        { nombre:"Lionel Messi",     pais:"Argentina",  flag:"🇦🇷", precio:255000, hp:96, pos:"Delantero",     color1:"#74acdf", color2:"#ffffff", img:"messi_255000_gemas.png",          gemMin:5000,  gemMax:13800  },
        { nombre:"Cristiano R.",     pais:"Portugal",   flag:"🇵🇹", precio:420000, hp:97, pos:"Delantero",     color1:"#006600", color2:"#ff0000", img:"Cristiano_R_420000_gemas.png",    gemMin:10350, gemMax:21700  },
        { nombre:"Lamine Yamal",     pais:"España",     flag:"🇪🇸", precio:680000, hp:98, pos:"Extremo",       color1:"#c60b1e", color2:"#ffc400", img:"lamine_yamal_85000_gemas.png",    gemMin:13320, gemMax:34800  },
        { nombre:"Balón de Oro NFT", pais:"Mundo",      flag:"🌍",  precio:999999, hp:99, pos:"Leyenda",       color1:"#ffd700", color2:"#ff8c00", img:"bellingham_65000_gemass.png",     gemMin:24350, gemMax:53700  },
    ];

    // ── CATÁLOGO DE HABILIDADES (LOGROS) ──────────────────────────────────
    // Regla: 100 reps = 1💎, 200=2💎, 300=3💎, 400=4💎, 500+=5💎 (máx)
    // Cada hito reclamado = +100 pts
    const SKILLS = [
        { id:'pase_largo',      nombre:'Pase Largo',        icon:'🦶', cat:'Pase',  desc:'Pases largos ejecutados' },
        { id:'pase_corto',      nombre:'Pase Corto',        icon:'👟', cat:'Pase',  desc:'Pases cortos ejecutados' },
        { id:'pase_medio',      nombre:'Pase Medio',        icon:'⚽', cat:'Pase',  desc:'Pases medios ejecutados' },
        { id:'interior',        nombre:'Interior',          icon:'🎯', cat:'Golpeo',desc:'Golpes de interior' },
        { id:'empeine',         nombre:'Empeine',           icon:'💥', cat:'Golpeo',desc:'Golpes de empeine' },
        { id:'exterior',        nombre:'Exterior',          icon:'🔄', cat:'Golpeo',desc:'Golpes de exterior' },
        { id:'tacon',           nombre:'Tacón',             icon:'👁️', cat:'Golpeo',desc:'Golpes de tacón' },
        { id:'cabeza',          nombre:'Cabeza',            icon:'🏅', cat:'Golpeo',desc:'Remates de cabeza' },
        { id:'pase_hueco',      nombre:'Pase Hueco',        icon:'🕳️', cat:'Técnica',desc:'Pases en profundidad' },
        { id:'pase_pared',      nombre:'Pase de Pared',     icon:'🔁', cat:'Técnica',desc:'Combinaciones 1-2' },
        { id:'centro',          nombre:'Centro',            icon:'📐', cat:'Técnica',desc:'Centros al área' },
        { id:'pase_atras',      nombre:'Pase Atrás',        icon:'↩️', cat:'Pase',  desc:'Pases hacia atrás' },
        { id:'pase_curvo',      nombre:'Pase Curvo',        icon:'🌀', cat:'Técnica',desc:'Pases con efecto' },
        { id:'saque_meta',      nombre:'Saque de Meta',     icon:'🥅', cat:'Saque', desc:'Saques desde portería' },
        { id:'saque_centro',    nombre:'Saque de Centro',   icon:'🏟️', cat:'Saque', desc:'Saques de centro' },
        { id:'saque_banda',     nombre:'Saque de Banda',    icon:'🚩', cat:'Saque', desc:'Saques de banda' },
        { id:'tiro_libre_dir',  nombre:'Tiro Libre Directo',icon:'⚡', cat:'Tiro',  desc:'Tiros libres directos' },
        { id:'tiro_libre_ind',  nombre:'Tiro Libre Indirecto',icon:'🔃',cat:'Tiro', desc:'Tiros libres indirectos' },
    ];

    // Hitos por habilidad: 100,200,300,400,500,600,700,800,900,1000
    const SKILL_MILESTONES = [100,200,300,400,500,600,700,800,900,1000];

    function getSkillGems(reps) {
        // 100=1, 200=2, 300=3, 400=4, 500+=5 (máximo 5)
        const hito = Math.floor(reps / 100) * 100;
        if(hito <= 0) return 0;
        return Math.min(5, Math.floor(hito / 100));
    }

    function getSkillMilestoneGems(milestone) {
        // Para el hito específico (100,200,...,1000)
        return Math.min(5, milestone / 100);
    }

    // ── SVG FALLBACK ──────────────────────────────────────────────────────
    function generatePlayerSVG(player) {
        const {color1,color2,flag,pais,pos,hp}=player;
        const countryBgs={'Brasil':['#009c3b','#ffd700','#002776'],'Colombia':['#fcd116','#003087','#ce1126'],'Chile':['#d52b1e','#ffffff','#0032a0'],'Argentina':['#74acdf','#ffffff','#74acdf'],'Portugal':['#006600','#ff0000','#ffffff'],'Inglaterra':['#cf142b','#ffffff','#003399'],'Francia':['#002395','#ffffff','#ed2939'],'España':['#c60b1e','#ffc400','#c60b1e'],'Noruega':['#ef2b2d','#ffffff','#002868'],'Mundo':['#ffd700','#ff8c00','#ffa500']};
        const [bg1,bg2,bg3]=countryBgs[pais]||['#1a1a1a','#333','#555'];
        const safeId=pais.replace(/\s/g,'');
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 380"><defs><radialGradient id="bg${safeId}" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="${bg2}" stop-opacity="0.9"/><stop offset="60%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg3}"/></radialGradient></defs><rect width="300" height="380" fill="url(#bg${safeId})" rx="16"/><circle cx="155" cy="185" r="105" fill="${color1}" opacity="0.18"/><ellipse cx="150" cy="128" rx="52" ry="50" fill="#FDBCB4"/><ellipse cx="150" cy="90" rx="52" ry="28" fill="${color1}"/><path d="M112 265 Q130 290 148 265 L158 265 Q176 290 178 265 L185 240 Q150 255 115 240 Z" fill="${color1}"/><path d="M115 170 Q95 175 90 200 L100 240 Q150 255 200 240 L208 200 Q204 175 185 170 Z" fill="${color1}"/><ellipse cx="130" cy="128" rx="14" ry="16" fill="white"/><circle cx="130" cy="128" r="6" fill="#111"/><circle cx="126" cy="124" r="3" fill="white"/><ellipse cx="168" cy="128" rx="14" ry="16" fill="white"/><circle cx="168" cy="128" r="6" fill="#111"/><circle cx="164" cy="124" r="3" fill="white"/><path d="M136 146 Q150 158 164 146" stroke="#cc6666" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="10" y="10" width="40" height="28" rx="6" fill="rgba(0,0,0,0.6)"/><text x="30" y="30" text-anchor="middle" font-size="18">${flag}</text><rect x="210" y="10" width="80" height="22" rx="11" fill="rgba(0,0,0,0.6)" stroke="${color2}" stroke-width="1"/><text x="250" y="25" text-anchor="middle" font-family="sans-serif" font-size="11" fill="${color2}" font-weight="bold">${pos.toUpperCase()}</text><rect x="230" y="335" width="55" height="32" rx="10" fill="rgba(0,0,0,0.75)" stroke="#ffd700" stroke-width="1.5"/><text x="257" y="349" text-anchor="middle" font-family="monospace" font-size="9" fill="#ffd700">OVR</text><text x="257" y="362" text-anchor="middle" font-family="monospace" font-size="14" font-weight="bold" fill="#ffd700">${hp}</text></svg>`;
    }
    function playerImgSrc(idx){const c=PLAYERS[idx];if(c.img)return GITHUB_IMG+c.img;return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(generatePlayerSVG(c));}
    function playerImgFallback(c){return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(generatePlayerSVG(c));}

    // ── ESTADO ────────────────────────────────────────────────────────────
    const $id = id => document.getElementById(id);
    const statusMsg = $id('status-msg');
    let gemas=0, hp=0, puntaje=0, nivel=1, statsPartidas=0;
    let totalGoals = 0;
    let carrosComprados=[];
    let durabilidades={}, ballonesPorJugador={};
    let _currentMatchMode='pve', _currentMatchCancha='', _currentMatchPlayer=null;
    let _matchResultPending=null, _pvpModeSelected='liga';
    let _selectedSquadSlot=null;
    let _equipamiento={};
    let _marketQty={};
    // Estado de habilidades: { skill_id: count }
    let skillCounts = {};

    // ── SISTEMA DE NIVEL ──────────────────────────────────────────────────
    const NIVEL_THRESHOLDS = [0,1,3,5,8,12,17,23,30,38,47];
    function calcularNivel() {
        const totalNFTs = carrosComprados.reduce((s,e)=>s+e.qty,0);
        let nv = 1;
        for(let i=NIVEL_THRESHOLDS.length-1;i>=1;i--) {
            if(totalNFTs >= NIVEL_THRESHOLDS[i]) { nv=i; break; }
        }
        return nv;
    }
    function gemasBonus() { return parseFloat(((nivel-1)*0.1).toFixed(1)); }
    function nivelWinBonus() { return Math.min(0.15, (nivel-1)*0.02); }

    // ── SISTEMA DE GOLES ──────────────────────────────────────────────────
    function getGoalCycleInfo() {
        const cycleSize = 1000;
        const cycle = Math.floor(totalGoals / cycleSize) + 1;
        const goalsInCycle = totalGoals % cycleSize;
        return { cycle, goalsInCycle };
    }
    function getGoalMilestones() {
        const info = getGoalCycleInfo();
        const claimedGoals = JSON.parse(localStorage.getItem(_pfx()+'_claimed_goal_milestones')||'{}');
        const milestones = [];
        for(let m=100; m<=1000; m+=100) {
            const gems = m/100;
            const key = `cycle${info.cycle}_${m}`;
            milestones.push({ goalsNeeded: m, gems, achieved: info.goalsInCycle >= m, claimed: !!claimedGoals[key], key });
        }
        return milestones;
    }
    function claimGoalMilestone(key, gems) {
        const claimedGoals = JSON.parse(localStorage.getItem(_pfx()+'_claimed_goal_milestones')||'{}');
        if(claimedGoals[key]) { mostrarMensaje('✅ Ya reclamado','#888'); return; }
        gemas += gems;
        claimedGoals[key] = true;
        localStorage.setItem(_pfx()+'_claimed_goal_milestones', JSON.stringify(claimedGoals));
        if(typeof saveState==='function') saveState();
        actualizarUI();
        buildRewardPts();
        mostrarMensaje(`✅ +${gems} 💎 por hito de goles!`, '#00ff88');
    }

    // ── BALONES ───────────────────────────────────────────────────────────
    function slotKey(idx,copy){return `${idx}_${copy}`;}
    // ── NFT FREE (Alexis Sánchez): 1 por wallet, 2 balones/24h, 160 💎 en 90 días ──
    function isFreeNFT(idx){ return !!(PLAYERS[idx] && PLAYERS[idx].free); }
    function getBalonesCapacidad(idx){ return isFreeNFT(idx) ? (PLAYERS[idx].freeBalones||2) : 4; }
    function freshBalonesArr(idx){ return new Array(getBalonesCapacidad(idx)).fill(true); }
    // Registro global de wallets que ya reclamaron el NFT free (persistente entre sesiones)
    const FREE_NFT_CLAIMED_KEY = 'futmundi_free_nft_claimed_wallets';
    function _claimedWalletsMap(){ try { return JSON.parse(localStorage.getItem(FREE_NFT_CLAIMED_KEY)||'{}'); } catch(e){ return {}; } }
    function hasWalletClaimedFreeNFT(idx, walletAddr){
        if(!walletAddr) return false;
        const m = _claimedWalletsMap();
        return !!(m[walletAddr] && m[walletAddr][idx]);
    }
    function markWalletClaimedFreeNFT(idx, walletAddr){
        if(!walletAddr) return;
        const m = _claimedWalletsMap();
        if(!m[walletAddr]) m[walletAddr] = {};
        m[walletAddr][idx] = { fecha: new Date().toISOString(), dias: PLAYERS[idx].freeDias||90, gemas: PLAYERS[idx].freeGemasTotal||160 };
        localStorage.setItem(FREE_NFT_CLAIMED_KEY, JSON.stringify(m));
    }
    function currentWalletAddr(){
        try {
            const w = (typeof tonConnectUI!=='undefined') ? (tonConnectUI?.wallet||tonConnectUI?.account) : null;
            return w?.account?.address || w?.address || null;
        } catch(e){ return null; }
    }

    function getBallonesJugador(idx,copy=0){const k=slotKey(idx,copy);if(!ballonesPorJugador[k])ballonesPorJugador[k]=freshBalonesArr(idx);return ballonesPorJugador[k];}
    function consumirBalonJugador(idx,copy=0){const balls=getBallonesJugador(idx,copy);const pos=balls.findIndex(b=>b===true);if(pos===-1)return false;balls[pos]=false;ballonesPorJugador[slotKey(idx,copy)]=balls;return true;}
    function totalBallonesDisponibles(){return carrosComprados.reduce((sum,e)=>{for(let c=0;c<e.qty;c++)sum+=getBallonesJugador(e.idx,c).filter(Boolean).length;return sum;},0);}
    function totalBallonesMax(){return carrosComprados.reduce((sum,e)=>sum+e.qty*4,0);}

    function getDurabilidad(idx,copy=0){const k=slotKey(idx,copy);if(durabilidades[k]===undefined)durabilidades[k]=100;return parseFloat(parseFloat(durabilidades[k]).toFixed(1));}
    function reducirDurabilidad(idx,copy=0){const k=slotKey(idx,copy);if(durabilidades[k]===undefined)durabilidades[k]=100;durabilidades[k]=Math.max(0,durabilidades[k]-0.8);}
    function repararDurabilidad(idx,copy=0){durabilidades[slotKey(idx,copy)]=100;}
    function colorDurabilidad(pct){return pct>=60?'dur-high':pct>=30?'dur-med':'dur-low';}

    function getPlayerEntry(idx){return carrosComprados.find(e=>e.idx===idx);}
    function getPlayerQty(idx){const e=getPlayerEntry(idx);return e?e.qty:0;}
    function generatePlayerId(idx,copy=0){return 'FM-'+String(2025000+idx*137+copy*31+43).padStart(8,'0');}
    function getSlotEquip(idx,copy){return (_equipamiento && _equipamiento[slotKey(idx,copy)]) || {};}
    function getEquipBonuses(eq){
        const bonuses={spd:0,def:0,phy:0,count:0};
        if(eq.uniforme){bonuses.count++; if(typeof eq.uniforme==='object' && eq.uniforme.fisico) bonuses.phy += Math.round(eq.uniforme.fisico/100);}
        if(eq.tenis){bonuses.count++; if(typeof eq.tenis==='object') bonuses.spd += Math.round(eq.tenis.bonus||0);}
        if(eq.protector){bonuses.count++; if(typeof eq.protector==='object') bonuses.def += Math.round((eq.protector.bonus||0)*0.6);}
        return bonuses;
    }
    function getSlotOVR(idx,copy){const c=PLAYERS[idx];const b=getEquipBonuses(getSlotEquip(idx,copy));return c.hp+b.spd+b.def+b.phy;}

    // ── MENSAJES ──────────────────────────────────────────────────────────
    function mostrarMensaje(texto,color='#888'){statusMsg.textContent=texto;statusMsg.style.color=color;clearTimeout(mostrarMensaje._t);mostrarMensaje._t=setTimeout(()=>{statusMsg.textContent='';},5000);}

    // ── PERSISTENCIA POR WALLET ───────────────────────────────────────────
    // Cada wallet tiene su propio espacio de datos en localStorage.
    // Las claves se prefizan con la dirección de la wallet conectada.
    let _activeWalletAddr = null; // dirección activa (se setea al conectar)

    function _isLikelyTonWalletAddress(addr){
        const s = String(addr||'').trim();
        if(!s || s === 'guest' || s.startsWith('fm_') || s.startsWith('dev_')) return false;
        // Aceptamos cualquier cadena larga (TonConnect) o formato crudo
        if(s.length > 30) return true;
        if(s.startsWith('0:') || s.startsWith('-1:')) return true;
        return false;
    }

    function _shortTonWallet(addr){
        const s = String(addr||'').trim();
        return s ? (s.slice(0,5)+'...'+s.slice(-5)) : '—';
    }

    function _walletAddr(){
        // Intenta obtener únicamente la dirección real de TonConnect.
        // Nunca devuelve IDs internos generados por la web.
        try{
            const w = tonConnectUI?.wallet || tonConnectUI?.account;
            const addr = w?.account?.address || w?.address || null;
            if(_isLikelyTonWalletAddress(addr)) return addr;
        }catch(e){}
        return _isLikelyTonWalletAddress(_activeWalletAddr) ? _activeWalletAddr : null;
    }

    function _pfx(){
        // Prefijo de clave = dirección de wallet, o 'guest' si no hay wallet
        const addr = _walletAddr();
        return addr ? 'fm_'+addr : 'fm_guest';
    }

    function _k(key){ return _pfx()+'_'+key; }

    function resetStateVars(){
        // Reinicia todas las variables de estado en memoria a 0
        gemas=0; hp=0; puntaje=0; nivel=1; statsPartidas=0; totalGoals=0;
        carrosComprados=[]; durabilidades={}; ballonesPorJugador={};
        _equipamiento={}; skillCounts={}; _itemsComprados={tenis:{},entrenador:{}}; _uniformesComprados={};
    }

    function saveState(){
        const p=_pfx();
        localStorage.setItem(p+'_gemas',gemas.toString());
        localStorage.setItem(p+'_hp',hp.toString());
        localStorage.setItem(p+'_puntaje',puntaje.toString());
        localStorage.setItem(p+'_stats_partidas',statsPartidas.toString());
        localStorage.setItem(p+'_total_goals',totalGoals.toString());
        localStorage.setItem(p+'_carros',JSON.stringify(carrosComprados));
        localStorage.setItem(p+'_durabilidades',JSON.stringify(durabilidades));
        localStorage.setItem(p+'_ballones',JSON.stringify(ballonesPorJugador));
        localStorage.setItem(p+'_equipamiento',JSON.stringify(_equipamiento));
        localStorage.setItem(p+'_skill_counts',JSON.stringify(skillCounts));
        localStorage.setItem(p+'_inv_items',JSON.stringify(_itemsComprados));
        localStorage.setItem(p+'_inv_uniformes',JSON.stringify(_uniformesComprados));
    }

    function loadState(){
        const p=_pfx();
        gemas=parseFloat(localStorage.getItem(p+'_gemas')||'0');
        hp=parseInt(localStorage.getItem(p+'_hp')||'0');
        puntaje=parseInt(localStorage.getItem(p+'_puntaje')||'0');
        statsPartidas=parseInt(localStorage.getItem(p+'_stats_partidas')||'0');
        totalGoals=parseInt(localStorage.getItem(p+'_total_goals')||'0');
        const c=localStorage.getItem(p+'_carros');
        if(c){try{const parsed=JSON.parse(c);if(parsed.length&&typeof parsed[0]==='number'){carrosComprados=parsed.map(idx=>({idx,qty:1}));}else{carrosComprados=parsed;}}catch(e){carrosComprados=[];}}
        else{carrosComprados=[];}
        const d=localStorage.getItem(p+'_durabilidades');durabilidades=d?JSON.parse(d):{};
        const b=localStorage.getItem(p+'_ballones');ballonesPorJugador=b?JSON.parse(b):{};
        const eq=localStorage.getItem(p+'_equipamiento');_equipamiento=eq?JSON.parse(eq):{};
        const sc=localStorage.getItem(p+'_skill_counts');skillCounts=sc?JSON.parse(sc):{};
        const inv=localStorage.getItem(p+'_inv_items');if(inv){try{_itemsComprados=JSON.parse(inv);}catch(e){_itemsComprados={tenis:{},entrenador:{}};}}else{_itemsComprados={tenis:{},entrenador:{}};}
        const invu=localStorage.getItem(p+'_inv_uniformes');if(invu){try{_uniformesComprados=JSON.parse(invu);}catch(e){_uniformesComprados={};}}else{_uniformesComprados={};}

        // ── SEED: 2 NFTs de Messi para wallet específica ─────────────────
        // Mantiene durabilidad por defecto (100) y rango de gemas
        // definido en PLAYERS[9] (gemMin:5000, gemMax:13800).
        // Compara normalizando: TonConnect entrega "0:hex" (raw), pero el
        // usuario nos pasa "UQ..." (user-friendly). Ambas formas representan
        // la misma cuenta y deben matchear.
        try{
            const _SEED_WALLETS = [
                'UQB9uFaCgM5HVntXHe-mq3xYiYjcLEzvgnZUCffNC5DR-7vg',
                '0:7db8568280ce47567b571defa6ab7c588988dc2c4cef82765409f7cd0b90d1fb',
                '7db8568280ce47567b571defa6ab7c588988dc2c4cef82765409f7cd0b90d1fb'
            ].map(s=>s.toLowerCase());
            const _MESSI_IDX = 9;
            const _SEED_QTY = 2;
            const _raw = (_walletAddr()||'').toLowerCase();
            // Extrae sólo el hash hex (últimos 64 hex chars) para tolerar
            // variantes "0:hex", "UQ...", "EQ..." y prefijos de workchain.
            const _hashMatch = _raw.match(/[0-9a-f]{64}/i);
            const _hash = _hashMatch ? _hashMatch[0] : '';
            const _targetHash = '7db8568280ce47567b571defa6ab7c588988dc2c4cef82765409f7cd0b90d1fb';
            const _isTarget = _SEED_WALLETS.includes(_raw) || _hash === _targetHash;
            if(_isTarget){
                const seedFlag = p+'_seed_messi_v1';
                if(!localStorage.getItem(seedFlag)){
                    const existing = carrosComprados.find(e=>e.idx===_MESSI_IDX);
                    if(existing){ existing.qty += _SEED_QTY; }
                    else { carrosComprados.push({idx:_MESSI_IDX, qty:_SEED_QTY}); }
                    localStorage.setItem(p+'_carros', JSON.stringify(carrosComprados));
                    localStorage.setItem(seedFlag, '1');
                    console.log('[seed] 2 NFTs de Messi añadidos a', _raw);
                }
            }
        }catch(e){ console.warn('seed messi failed', e); }

        // ── SEED: 1 NFT Harry Kane (6900 gemas) para wallet específica ──────
        // PLAYERS[3] = Harry Kane · precio:6900 · hp:84 · Delantero · 🇬🇧
        // gemMin:150 · gemMax:320 💎/día · durabilidad:100 · 4 balones
        // Wallet: UQCMCAUMxYrI51d3kmYEVePhA1p6mvO3Htd-i6IkVgBb7T_P
        try{
            const _KANE_WALLETS = [
                'UQCMCAUMxYrI51d3kmYEVePhA1p6mvO3Htd-i6IkVgBb7T_P',
                '0:8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed',
                '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed'
            ].map(s=>s.toLowerCase());
            const _KANE_IDX = 3;   // PLAYERS[3] = Harry Kane
            const _KANE_QTY = 1;
            const _rawK = (_walletAddr()||'').toLowerCase();
            const _hashMatchK = _rawK.match(/[0-9a-f]{64}/i);
            const _hashK = _hashMatchK ? _hashMatchK[0] : '';
            const _targetHashK = '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed';
            const _isTargetK = _KANE_WALLETS.includes(_rawK) || _hashK === _targetHashK;
            if(_isTargetK){
                const seedFlagK = p+'_seed_kane_v1';
                if(!localStorage.getItem(seedFlagK)){
                    const existingK = carrosComprados.find(e=>e.idx===_KANE_IDX);
                    const _startCopyK = existingK ? existingK.qty : 0;
                    if(existingK){ existingK.qty += _KANE_QTY; }
                    else { carrosComprados.push({idx:_KANE_IDX, qty:_KANE_QTY}); }
                    // Inicializar parámetros completos igual que comprarCarro():
                    // hp +84, puntaje +690 (precio/10), durabilidad 100, 4 balones
                    const _kanePlayer = PLAYERS[_KANE_IDX];
                    hp    += _kanePlayer.hp * _KANE_QTY;          // +84 OVR
                    puntaje += Math.round(_kanePlayer.precio / 10) * _KANE_QTY; // +690 pts
                    for(let _kc = _startCopyK; _kc < _startCopyK + _KANE_QTY; _kc++){
                        durabilidades[slotKey(_KANE_IDX, _kc)]       = 100;
                        ballonesPorJugador[slotKey(_KANE_IDX, _kc)]  = freshBalonesArr(_KANE_IDX);
                    }
                    localStorage.setItem(p+'_carros',       JSON.stringify(carrosComprados));
                    localStorage.setItem(p+'_hp',           hp.toString());
                    localStorage.setItem(p+'_puntaje',      puntaje.toString());
                    localStorage.setItem(p+'_durabilidades',JSON.stringify(durabilidades));
                    localStorage.setItem(p+'_ballones',     JSON.stringify(ballonesPorJugador));
                    localStorage.setItem(seedFlagK, '1');
                    console.log('[seed] 1 NFT Harry Kane (6900💎 · OVR 84 · 4 balones · dur 100) añadido a', _rawK);
                }
            }
        }catch(e){ console.warn('seed kane failed', e); }

        // ── SEED: 1 NFT Neymar Jr. (320 gemas) para wallet específica ───────
        // PLAYERS[0] = Neymar Jr. · precio:320 · hp:72 · Delantero · 🇧🇷
        // gemMin:8 · gemMax:15 💎/día · durabilidad:100
        // Wallet: UQCMCAUMxYrI51d3kmYEVePhA1p6mvO3Htd-i6IkVgBb7T_P
        try{
            const _NEY_WALLETS = [
                'UQCMCAUMxYrI51d3kmYEVePhA1p6mvO3Htd-i6IkVgBb7T_P',
                '0:8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed',
                '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed'
            ].map(s=>s.toLowerCase());
            const _NEY_IDX = 0;   // PLAYERS[0] = Neymar Jr.
            const _NEY_QTY = 1;
            const _rawN = (_walletAddr()||'').toLowerCase();
            const _hashMatchN = _rawN.match(/[0-9a-f]{64}/i);
            const _hashN = _hashMatchN ? _hashMatchN[0] : '';
            const _targetHashN = '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed';
            const _isTargetN = _NEY_WALLETS.includes(_rawN) || _hashN === _targetHashN;
            if(_isTargetN){
                const seedFlagN = p+'_seed_neymar_v1';
                if(!localStorage.getItem(seedFlagN)){
                    const existingN = carrosComprados.find(e=>e.idx===_NEY_IDX);
                    const _startCopyN = existingN ? existingN.qty : 0;
                    if(existingN){ existingN.qty += _NEY_QTY; }
                    else { carrosComprados.push({idx:_NEY_IDX, qty:_NEY_QTY}); }
                    // Inicializar parámetros completos igual que comprarCarro():
                    // hp +72, puntaje +32 (precio/10), durabilidad 100, balones por defecto
                    const _neyPlayer = PLAYERS[_NEY_IDX];
                    hp    += _neyPlayer.hp * _NEY_QTY;          // +72 OVR
                    puntaje += Math.round(_neyPlayer.precio / 10) * _NEY_QTY; // +32 pts
                    for(let _nc = _startCopyN; _nc < _startCopyN + _NEY_QTY; _nc++){
                        durabilidades[slotKey(_NEY_IDX, _nc)]       = 100;
                        ballonesPorJugador[slotKey(_NEY_IDX, _nc)]  = freshBalonesArr(_NEY_IDX);
                    }
                    localStorage.setItem(p+'_carros',       JSON.stringify(carrosComprados));
                    localStorage.setItem(p+'_hp',           hp.toString());
                    localStorage.setItem(p+'_puntaje',      puntaje.toString());
                    localStorage.setItem(p+'_durabilidades',JSON.stringify(durabilidades));
                    localStorage.setItem(p+'_ballones',     JSON.stringify(ballonesPorJugador));
                    localStorage.setItem(seedFlagN, '1');
                    console.log('[seed] 1 NFT Neymar Jr. (320💎 · OVR 72 · dur 100) añadido a', _rawN);
                }
            }
        }catch(e){ console.warn('seed neymar failed', e); }

        // ── SEED v2: +1 NFT Harry Kane adicional (6900 gemas) ───────────────
        // Suma una segunda unidad de Harry Kane a la misma wallet, manteniendo
        // intacto _seed_kane_v1. Usa flag independiente _seed_kane_v2.
        // PLAYERS[3] = Harry Kane · precio:6900 · hp:84 · 4 balones · dur:100
        try{
            const _KANE2_WALLETS = [
                'UQCMCAUMxYrI51d3kmYEVePhA1p6mvO3Htd-i6IkVgBb7T_P',
                '0:8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed',
                '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed'
            ].map(s=>s.toLowerCase());
            const _KANE2_IDX = 3;
            const _KANE2_QTY = 1;
            const _rawK2 = (_walletAddr()||'').toLowerCase();
            const _hashMatchK2 = _rawK2.match(/[0-9a-f]{64}/i);
            const _hashK2 = _hashMatchK2 ? _hashMatchK2[0] : '';
            const _targetHashK2 = '8c08050cc58ac8e7577792660455e3e1035a7a9af3b71ed77e8ba22456005bed';
            const _isTargetK2 = _KANE2_WALLETS.includes(_rawK2) || _hashK2 === _targetHashK2;
            if(_isTargetK2){
                const seedFlagK2 = p+'_seed_kane_v2';
                if(!localStorage.getItem(seedFlagK2)){
                    const existingK2 = carrosComprados.find(e=>e.idx===_KANE2_IDX);
                    const _startCopyK2 = existingK2 ? existingK2.qty : 0;
                    if(existingK2){ existingK2.qty += _KANE2_QTY; }
                    else { carrosComprados.push({idx:_KANE2_IDX, qty:_KANE2_QTY}); }
                    const _kanePlayer2 = PLAYERS[_KANE2_IDX];
                    hp    += _kanePlayer2.hp * _KANE2_QTY;          // +84 OVR
                    puntaje += Math.round(_kanePlayer2.precio / 10) * _KANE2_QTY; // +690 pts
                    for(let _kc2 = _startCopyK2; _kc2 < _startCopyK2 + _KANE2_QTY; _kc2++){
                        durabilidades[slotKey(_KANE2_IDX, _kc2)]       = 100;
                        ballonesPorJugador[slotKey(_KANE2_IDX, _kc2)]  = freshBalonesArr(_KANE2_IDX);
                    }
                    localStorage.setItem(p+'_carros',       JSON.stringify(carrosComprados));
                    localStorage.setItem(p+'_hp',           hp.toString());
                    localStorage.setItem(p+'_puntaje',      puntaje.toString());
                    localStorage.setItem(p+'_durabilidades',JSON.stringify(durabilidades));
                    localStorage.setItem(p+'_ballones',     JSON.stringify(ballonesPorJugador));
                    localStorage.setItem(seedFlagK2, '1');
                    console.log('[seed v2] +1 NFT Harry Kane adicional (6900💎 · OVR 84 · 4 balones · dur 100) añadido a', _rawK2);
                }
            }
        }catch(e){ console.warn('seed kane v2 failed', e); }

        nivel=calcularNivel();
    }

    // Llamado al cambiar de wallet: carga la sesión de la wallet conectada
    function onWalletChange(newAddr){
        if(newAddr===_activeWalletAddr) return; // misma wallet, nada que hacer
        _activeWalletAddr = newAddr;
        resetStateVars();
        loadState();
        checkDailyBallRecharge();
        actualizarUI();
        buildMarket();
        buildUniforms();
        buildSkillLogros();
        buildFutsalaBody();
        // Detectar y registrar código de referido (solo si hay wallet conectada)
        if(newAddr) { _detectarReferido(); _resolverPendientesDeReferidos(); }
        // Mostrar badge con dirección abreviada en top bar
        const badge=$id('wallet-addr-badge');
        const addrText=$id('wallet-addr-text');
        const tonAddr = _isLikelyTonWalletAddress(newAddr) ? newAddr : '';
        if(tonAddr){
            const short=_shortTonWallet(tonAddr);
            if(addrText)addrText.textContent='TON '+short;
            if(badge)badge.style.display='flex';
            mostrarMensaje('✅ TON Wallet vinculada: '+short,'#00ff88');
        } else {
            if(badge)badge.style.display='none';
            mostrarMensaje(newAddr ? '🔒 ID interno oculto' : '🔌 Wallet desconectada','#888');
        }
    }

    function checkDailyBallRecharge(){
        const now=new Date();const todayKey=`${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
        const lastRecharge=localStorage.getItem(_pfx()+'_ball_recharge_day');
        if(lastRecharge===todayKey)return;
        if(now.getUTCHours()>=7){carrosComprados.forEach(e=>{for(let c=0;c<e.qty;c++)ballonesPorJugador[slotKey(e.idx,c)]=freshBalonesArr(e.idx);});localStorage.setItem(_pfx()+'_ball_recharge_day',todayKey);saveState();}
    }

    // ── UI ────────────────────────────────────────────────────────────────
    function actualizarUI(){
        nivel = calcularNivel();
        $id('gemas-stat').textContent=gemas.toFixed(1);
        $id('hp-stat').textContent=hp;
        $id('puntaje').textContent=puntaje;
        $id('nivel-stat').textContent=nivel;
        $id('modal-nivel-num').textContent=nivel;
        const totalNFTs=carrosComprados.reduce((s,e)=>s+e.qty,0);
        const nftEl=$id('modal-nivel-nfts');if(nftEl)nftEl.textContent=`NFTs: ${totalNFTs}`;
        const md=$id('market-gemas-display');if(md)md.textContent=gemas.toFixed(1)+' 💎';
        const mr=$id('my-rank-score');if(mr)mr.textContent=puntaje+' pts';
        const totalBalls=totalBallonesDisponibles();
        const fuelEl=$id('fuel-count-display');if(fuelEl)fuelEl.textContent=totalBalls;
        const fuelElM=$id('fuel-count-display-m');if(fuelElM)fuelElM.textContent=totalBalls;
        const topForm=$id('gasolina');if(topForm)topForm.textContent=totalNFTs>0?`⚽${totalBalls}`:'—';
        const bonus=gemasBonus();
        const winB=Math.round(nivelWinBonus()*100);
        const nbGems=$id('nb-gems-bonus');if(nbGems)nbGems.textContent=`+${bonus.toFixed(1)} 💎`;
        const nbPts=$id('nb-pts-bonus');if(nbPts)nbPts.textContent=`+${nivel*2} pts`;
        const nbWin=$id('nb-win-bonus');if(nbWin)nbWin.textContent=`+${winB}%`;
        const currentThresh=NIVEL_THRESHOLDS[nivel-1]||0;
        const nextThresh=NIVEL_THRESHOLDS[nivel]||NIVEL_THRESHOLDS[NIVEL_THRESHOLDS.length-1];
        const xp=totalNFTs-currentThresh;const xpNeeded=nextThresh-currentThresh;
        const pct=Math.min(100,Math.round((xp/xpNeeded)*100));
        const xpLabel=$id('nivel-xp-label');if(xpLabel)xpLabel.innerHTML=`<span>NFTs: ${totalNFTs}</span><span>Sig. nivel: ${nextThresh} NFTs</span>`;
        const barFill=$id('nivel-bar-fill');if(barFill)barFill.style.width=pct+'%';
        const fnb=$id('futcancha-nivel-bonus');
        if(fnb)fnb.textContent=bonus>0?`(Niv.${nivel}: +${bonus.toFixed(1)}💎 bonus sobre rango NFT)`:'';
        const info=getGoalCycleInfo();
        const gd=$id('goals-display');if(gd)gd.textContent=totalGoals;
        const cd=$id('cycle-display');if(cd)cd.textContent=info.cycle;
        const gcd=$id('goals-in-cycle-display');if(gcd)gcd.textContent=`${info.goalsInCycle} / 1000`;
        saveState();
    }

    // ── TORNEO COUNTDOWN ──────────────────────────────────────────────────
    function updateTorneoCountdown(){
        const now=new Date();const day=now.getUTCDay();
        const midnight=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
        const daysUntilFri=(5-day+7)%7;
        let nextFri=new Date(midnight.getTime()+daysUntilFri*86400000);
        if(day===5&&now.getUTCHours()===0&&now.getUTCMinutes()===0)nextFri=new Date(nextFri.getTime()+7*86400000);
        const isActive=(day>=1&&day<=4)||(day===5&&now.getUTCHours()===0&&now.getUTCMinutes()===0);
        let msUntilEnd=nextFri-now;if(msUntilEnd<0)msUntilEnd=0;
        const totalSec=Math.floor(msUntilEnd/1000);
        const days=Math.floor(totalSec/86400);const hours=Math.floor((totalSec%86400)/3600);const mins=Math.floor((totalSec%3600)/60);const secs=totalSec%60;
        const pad=n=>String(n).padStart(2,'0');
        const dEl=$id('tc-days');const hEl=$id('tc-hours');const mEl=$id('tc-mins');const sEl=$id('tc-secs');
        if(dEl)dEl.textContent=days;if(hEl)hEl.textContent=pad(hours);if(mEl)mEl.textContent=pad(mins);if(sEl)sEl.textContent=pad(secs);
        const statusEl=$id('torneo-status-label');
        if(statusEl){if(isActive){statusEl.textContent='🔴 TORNEO EN CURSO — ¡Compite ahora!';statusEl.style.color='var(--green)';}else{statusEl.textContent='⏳ Próximo torneo: Lunes 00:00 UTC';statusEl.style.color='#888';}}
    }
    setInterval(updateTorneoCountdown,1000);

    // ── MODALES ───────────────────────────────────────────────────────────
    function openModal(id){
        const el=$id(id);if(!el)return;
        el.classList.add('active');document.body.style.overflow='hidden';document.body.classList.add('modal-open');
        if(id==='modal-marketplace'){actualizarUI();buildMarket();buildUniforms();buildItemsMarket();}
        if(id==='modal-recompensa')checkRewardStatus();
        if(id==='modal-recompensa-pts'){actualizarUI();buildRewardPts();}
        if(id==='modal-garage')buildGarage();
        if(id==='modal-mantenimiento')buildMantenimiento();
        if(id==='modal-logros')buildSkillLogros();
        if(id==='modal-duelo-callejero')buildFutsalaBody();
        if(id==='modal-nivel')actualizarUI();
        if(id==='modal-torneo'){updateTorneoCountdown(); if(typeof torneoActualizarContadorUsuariosNFT==='function') torneoActualizarContadorUsuariosNFT();}
    }
    function closeModal(id){const el=$id(id);if(!el)return;el.classList.remove('active');document.body.style.overflow='';if(!document.querySelector('.modal-overlay.active'))document.body.classList.remove('modal-open');}
    document.querySelectorAll('.modal-overlay').forEach(ov=>{ov.addEventListener('click',e=>{if(e.target===ov)closeModal(ov.id);});});
    function switchTab(e,group,panel){const modal=$id(`modal-${group}`);if(!modal)return;modal.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));modal.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));e.currentTarget.classList.add('active');const panelEl=$id(`${group}-${panel}`);if(panelEl)panelEl.classList.add('active');}
    function irADepositoTorneo(){
        closeModal('modal-torneo');
        abrirPagoQR({
            tipo:'torneo',
            titulo:`🏆 Inscripción Torneo Semanal`,
            descripcion:`Inscripción al torneo. El pago se envía directamente al contrato inteligente.`,
            usdt:COSTO_TORNEO_USDT,
            onConfirmar:async()=>{
                if(!isWalletConnected()){mostrarMensaje('⚠️ Conecta tu wallet','#ffaa00');openWalletModal();return false;}
                mostrarMensaje(`⏳ Procesando $${COSTO_TORNEO_USDT.toFixed(2)} USDT...`,'#00d4ff');
                try{
                    const tx=await buildContractTx('torneo',COSTO_TORNEO_USDT);
                    await tonConnectUI.sendTransaction(tx);
                    mostrarMensaje('✅ ¡Inscripción al torneo confirmada!','#00ff88');
                    return true;
                }catch(e){mostrarMensaje('❌ Inscripción cancelada','#ff4444');return false;}
            }
        });
    }

    // ── MARKETPLACE: ZAPATILLAS Y ENTRENADORES ────────────────────────────
    const ITEMS_BASE_URL = 'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/';
    const ZAPATILLAS = [
        { nombre:'Zapatillas 1980', anio:1980, bonus:15, precio:300,  img:'zapatillas_1980_15%_300_gemas.png',  flag:'🥾' },
        { nombre:'Zapatillas 2000', anio:2000, bonus:35, precio:2500, img:'zapatillas_2000_35%2500_gemas.png',  flag:'⚡' },
        { nombre:'Zapatillas 2010', anio:2010, bonus:45, precio:1000, img:'zapatillas_2010_45%_1000_gemas.png', flag:'🔥' },
        { nombre:'Zapatillas 2020', anio:2020, bonus:65, precio:5000, img:'zapatillas_2020_65%_5000_gemas.png', flag:'💎' }
    ];
    const ENTRENADORES = [
        { nombre:'Entrenador Brasil',    pais:'Brasil',    flag:'🇧🇷', bonus:15, precio:300,  img:'entrenador_brasil_15%_300_gemas.png' },
        { nombre:'Entrenador Portugal',  pais:'Portugal',  flag:'🇵🇹', bonus:15, precio:300,  img:'entrenador_portugal_15%_300_gemas.png' },
        { nombre:'Entrenador Chile',     pais:'Chile',     flag:'🇨🇱', bonus:25, precio:600,  img:'entrenador_chile_25%_600_gemas.png' },
        { nombre:'Entrenador España',    pais:'España',    flag:'🇪🇸', bonus:35, precio:1000, img:'entrenador_españa_35%_1000_gemas.png' },
        { nombre:'Entrenador Francia',   pais:'Francia',   flag:'🇫🇷', bonus:25, precio:1200, img:'entrenador_francia_25%_1200_gemas.png' },
        { nombre:'Entrenador Alemania',  pais:'Alemania',  flag:'🇩🇪', bonus:35, precio:1250, img:'entrenador_alemania_35%_1250_gemas.png' },
        { nombre:'Entrenador Argentina', pais:'Argentina', flag:'🇦🇷', bonus:65, precio:3000, img:'entrenador_argentina_65%_3000_gemas.png' }
    ];
    // Inventario de items comprados (zapatillas y entrenadores)
    let _itemsComprados = { tenis:{}, entrenador:{} };
    function getItemList(kind){ return kind==='tenis'?ZAPATILLAS:ENTRENADORES; }
    function getItemKey(kind, idx){ return `${kind}_${idx}`; }
    function getItemQty(kind, idx){ return (_itemsComprados[kind] && _itemsComprados[kind][idx]) || 0; }
    function itemImgUrl(name){ return ITEMS_BASE_URL + encodeURI(name); }
    function itemFallback(item){
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'><stop offset='0' stop-color='%2300ff88'/><stop offset='1' stop-color='%230a1a0a'/></linearGradient></defs><rect width='200' height='200' fill='url(%23g)'/><text x='100' y='120' font-size='90' text-anchor='middle' font-family='sans-serif'>${item.flag||'🎁'}</text></svg>`;
        return 'data:image/svg+xml;utf8,' + svg;
    }
    function renderItemGrid(gridId, list, kind){
        const el = document.getElementById(gridId); if(!el) return;
        el.innerHTML = list.map((it,i)=>{
            const owned = getItemQty(kind, i);
            return `
            <div class="car-card">
                <div class="car-card-img-wrap">
                    <img class="car-card-img" src="${itemImgUrl(it.img)}" alt="${it.nombre}" onerror="this.onerror=null;this.src=&quot;${itemFallback(it)}&quot;" style="object-fit:cover">
                    <div style="position:absolute;top:6px;right:6px;background:rgba(0,255,136,0.9);border-radius:4px;padding:2px 6px;font-size:0.55em;color:#000;font-weight:800;letter-spacing:1px">+${it.bonus}%</div>
                    ${owned>0?`<div style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:6px;padding:2px 7px;font-size:0.6em;color:var(--gold);font-weight:800">✅ ×${owned}</div>`:''}
                </div>
                <div class="car-card-info">
                    <div class="car-card-name">${it.nombre}</div>
                    <div class="car-card-country">${it.flag||''} ${it.pais||(it.anio?('Año '+it.anio):'')}</div>
                    <div style="font-size:0.68em;color:var(--green);margin-bottom:3px;font-weight:700">⚡ Bonus +${it.bonus}% rendimiento</div>
                    <div class="car-card-price">💎 ${it.precio.toLocaleString()}</div>
                    <button class="buy-car-btn" onclick="comprarItem('${kind}',${i})">⚽ Comprar</button>
                </div>
            </div>`;
        }).join('');
    }
    function buildItemsMarket(){
        renderItemGrid('tenis-market-grid', ZAPATILLAS, 'tenis');
        renderItemGrid('entrenador-market-grid', ENTRENADORES, 'entrenador');
    }
    function comprarItem(kind, idx){
        const list = getItemList(kind);
        const it = list[idx]; if(!it) return;
        if(gemas < it.precio){ mostrarMensaje(`❌ Faltan ${(it.precio-gemas).toFixed(1)} 💎`,'#ff4444'); return; }
        gemas -= it.precio;
        if(!_itemsComprados[kind]) _itemsComprados[kind] = {};
        _itemsComprados[kind][idx] = (_itemsComprados[kind][idx] || 0) + 1;
        if(typeof saveState==='function') saveState();
        actualizarUI();
        buildItemsMarket();
        if(typeof buildGarageInventory==='function') buildGarageInventory();
        const md=document.getElementById('market-gemas-display'); if(md) md.textContent=gemas.toFixed(1)+' 💎';
        const tipo = kind==='tenis'?'👟 Zapatillas':'🏋️ Entrenador';
        mostrarMensaje(`✅ ${tipo} "${it.nombre}" añadido a tu inventario! Asígnalo desde Mi Plantilla`,'#00ff88');
    }

    // ── MARKETPLACE ───────────────────────────────────────────────────────
    function buildMarket(){
        const md=$id('market-gemas-display');if(md)md.textContent=gemas.toFixed(1)+' 💎';
        $id('car-market-grid').innerHTML=PLAYERS.map((c,i)=>{
            const owned=getPlayerQty(i);const imgSrc=playerImgSrc(i);const hasRealImg=!!c.img;
            const isFree=isFreeNFT(i);
            const walletAddr=currentWalletAddr();
            const walletClaimed=isFree && hasWalletClaimedFreeNFT(i, walletAddr);
            // Free NFT: máximo 1 por wallet; el resto: hasta MAX_PER_PLAYER
            const maxAllowed = isFree ? 1 : MAX_PER_PLAYER;
            const remaining = maxAllowed - owned;
            if(!_marketQty[i])_marketQty[i]=1;
            // Bloque de info: free vs normal
            const infoBlock = isFree
                ? `<div class="car-card-country">${c.flag} ${c.pais}</div>
                   <div style="font-size:0.68em;color:var(--gold);margin:4px 0 3px;font-weight:700">🎁 Generará ${c.freeGemasTotal} 💎</div>
                   <div class="car-card-price" style="color:var(--green)">GRATIS</div>`
                : `<div class="car-card-country">${c.flag} ${c.pais} · ⚡ OVR ${c.hp}</div>
                   <div style="font-size:0.68em;color:var(--green);margin-bottom:3px;font-weight:700">📈 ${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎/día</div>
                   <div class="car-card-price">💎 ${c.precio.toLocaleString()}</div>`;
            // Bloque de acción
            let actionBlock;
            if(isFree){
                if(owned>0 || walletClaimed){
                    actionBlock = `<button class="buy-car-btn" disabled>✅ Ya reclamado (1/wallet)</button>`;
                } else if(!walletAddr){
                    actionBlock = `<button class="buy-car-btn" disabled style="opacity:0.6">🔒 Conecta tu wallet</button>`;
                } else {
                    actionBlock = `<button class="buy-car-btn" onclick="reclamarFreeNFT(${i})" style="background:linear-gradient(135deg,rgba(66,245,141,0.25),rgba(255,216,77,0.18));border-color:var(--green);color:var(--green)">🎁 Reclamar Gratis</button>`;
                }
            } else if(remaining>0){
                actionBlock = `<div class="nft-qty-row">
                    <button class="nft-qty-btn" onclick="cambiarQtyMarket(${i},-1)">−</button>
                    <span class="nft-qty-num" id="mkt-qty-${i}">${_marketQty[i]||1}</span>
                    <button class="nft-qty-btn" onclick="cambiarQtyMarket(${i},1)">+</button>
                    <span class="nft-qty-max">(máx ${remaining})</span>
                </div>
                <div style="font-size:0.68em;color:var(--gold);margin-bottom:6px">Total: 💎 <span id="mkt-total-${i}">${((c.precio)*(_marketQty[i]||1)).toLocaleString()}</span></div>
                <button class="buy-car-btn" id="buy-btn-${i}" onclick="comprarCarro(${i})">⚽ Fichar ×<span id="mkt-qty-label-${i}">${_marketQty[i]||1}</span></button>`;
            } else {
                actionBlock = `<button class="buy-car-btn" disabled>✅ Máximo (${MAX_PER_PLAYER})</button>`;
            }
            return `<div class="car-card" id="card-${i}">
<div class="car-card-img-wrap" onclick="openCarDetail(${i},false)">
    <img class="car-card-img" src="${imgSrc}" alt="${c.nombre}" onerror="this.onerror=null;this.src='${playerImgFallback(c).replace(/'/g,"\\'")}'" style="object-fit:cover">
    ${hasRealImg?`<div style="position:absolute;top:6px;right:6px;background:${isFree?'rgba(255,216,77,0.95)':'rgba(0,255,136,0.9)'};border-radius:4px;padding:2px 6px;font-size:0.55em;color:#000;font-weight:800;letter-spacing:1px">${isFree?'FREE NFT':'NFT'}</div>`:''}
    ${owned>0?`<div style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.8);border:1px solid var(--gold);border-radius:4px;padding:2px 6px;font-size:0.55em;color:var(--gold);font-weight:800;font-family:'Orbitron',sans-serif">${owned}/${maxAllowed}</div>`:''}
</div>
<div class="car-card-info">
    <div class="car-card-name">${c.nombre}</div>
    ${infoBlock}
    ${actionBlock}
</div>
</div>`;}).join('');
    }
    function cambiarQtyMarket(idx,delta){if(isFreeNFT(idx))return;const owned=getPlayerQty(idx);const remaining=MAX_PER_PLAYER-owned;if(!_marketQty[idx])_marketQty[idx]=1;_marketQty[idx]=Math.max(1,Math.min(remaining,_marketQty[idx]+delta));const q=_marketQty[idx];const el=$id(`mkt-qty-${idx}`);if(el)el.textContent=q;const tl=$id(`mkt-total-${idx}`);if(tl)tl.textContent=(PLAYERS[idx].precio*q).toLocaleString();const ll=$id(`mkt-qty-label-${idx}`);if(ll)ll.textContent=q;}

    // Reclamar NFT FREE (Alexis Sánchez) — 1 por wallet, persistente
    function reclamarFreeNFT(idx){
        const c = PLAYERS[idx];
        if(!isFreeNFT(idx)){ return; }
        const walletAddr = currentWalletAddr();
        if(!walletAddr){
            mostrarMensaje('⚠️ Conecta tu wallet para reclamar el NFT free','#ffaa00');
            if(typeof openWalletModal==='function') openWalletModal();
            return;
        }
        if(hasWalletClaimedFreeNFT(idx, walletAddr) || getPlayerQty(idx)>0){
            mostrarMensaje('❌ Esta wallet ya reclamó este NFT free','#ff4444');
            return;
        }
        const entry=getPlayerEntry(idx);
        if(entry){entry.qty+=1;}else{carrosComprados.push({idx,qty:1});}
        hp+=c.hp; puntaje+=10;
        durabilidades[slotKey(idx,0)]=100;
        ballonesPorJugador[slotKey(idx,0)]=freshBalonesArr(idx);
        markWalletClaimedFreeNFT(idx, walletAddr);
        nivel=calcularNivel();
        if(typeof saveState==='function') saveState();
        actualizarUI();buildMarket();
        mostrarMensaje(`🎁 ¡${c.nombre} reclamado GRATIS! Generará ${c.freeGemasTotal} 💎`,'#42f58d');
    }

    function comprarCarro(idx){
        if(isFreeNFT(idx)){ reclamarFreeNFT(idx); return; }
        const c=PLAYERS[idx];const qty=_marketQty[idx]||1;const owned=getPlayerQty(idx);const remaining=MAX_PER_PLAYER-owned;
        if(qty>remaining){mostrarMensaje(`⚠️ Solo puedes comprar ${remaining} más de este jugador`,'#ffaa00');return;}
        const totalCost=c.precio*qty;
        if(gemas<totalCost){mostrarMensaje(`❌ Faltan ${(totalCost-gemas).toFixed(1)} 💎`,'#ff4444');return;}
        gemas-=totalCost;
        const entry=getPlayerEntry(idx);const startCopy=owned;
        if(entry){entry.qty+=qty;}else{carrosComprados.push({idx,qty});}
        hp+=c.hp*qty;puntaje+=Math.round(c.precio/10)*qty;
        for(let copy=startCopy;copy<startCopy+qty;copy++){durabilidades[slotKey(idx,copy)]=100;ballonesPorJugador[slotKey(idx,copy)]=freshBalonesArr(idx);}
        nivel=calcularNivel();
        actualizarUI();buildMarket();
        mostrarMensaje(`✅ ${qty}× ${c.nombre} fichado! Nivel → ${nivel} · +${qty*4} balones · 📈 ${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎/día`,'#00ff88');
    }

    // ── UNIFORMES MARKETPLACE ─────────────────────────────────────────────
    const UNIFORMES = [
        {
            id: 'bronce',
            nombre: 'Uniforme Bronce',
            tier: 'BRONCE',
            tierColor: '#cd7f32',
            tierBg: 'rgba(205,127,50,0.15)',
            tierBorder: 'rgba(205,127,50,0.5)',
            precio: 500,
            fisico: 1000,
            img: 'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/uniforme_bronce_1000_fisico_500_gemas.png',
            emoji: '🥉',
            bonus: '+1000 pts físico',
        },
        {
            id: 'platinium',
            nombre: 'Uniforme Platinium',
            tier: 'PLATINIUM',
            tierColor: '#e5e4e2',
            tierBg: 'rgba(229,228,226,0.1)',
            tierBorder: 'rgba(229,228,226,0.45)',
            precio: 1200,
            fisico: 2000,
            img: 'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/uniforme_platinium_2000_fisico_1200_gemas.png',
            emoji: '🥈',
            bonus: '+2000 pts físico',
        },
        {
            id: 'diamante',
            nombre: 'Uniforme Diamante',
            tier: 'DIAMANTE',
            tierColor: '#00d4ff',
            tierBg: 'rgba(0,212,255,0.12)',
            tierBorder: 'rgba(0,212,255,0.55)',
            precio: 7500,
            fisico: null,
            img: 'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/uniforme_diamante_7500_gemas.png',
            emoji: '💎',
            bonus: 'Tier máximo exclusivo',
        },
    ];

    let _uniformesQty = {};
    let _uniformesComprados = {};

    function buildUniforms() {
        const grid = $id('uniformes-market-grid');
        if (!grid) return;
        grid.innerHTML = UNIFORMES.map(u => {
            const owned = _uniformesComprados[u.id] || 0;
            if (!_uniformesQty[u.id]) _uniformesQty[u.id] = 1;
            return `<div class="car-card" style="border-color:${u.tierBorder};background:${u.tierBg};">
<div class="car-card-img-wrap">
    <img class="car-card-img" src="${u.img}" alt="${u.nombre}"
         onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex';"
         style="object-fit:cover;aspect-ratio:3/4;">
    <div style="display:none;width:100%;aspect-ratio:3/4;align-items:center;justify-content:center;font-size:3.5em;background:#0a130a;">${u.emoji}</div>
    <div style="position:absolute;top:6px;left:6px;background:${u.tierBg};border:1px solid ${u.tierBorder};border-radius:4px;padding:2px 8px;font-size:0.55em;color:${u.tierColor};font-weight:800;letter-spacing:1.5px;font-family:'Orbitron',sans-serif">${u.tier}</div>
    ${owned > 0 ? `<div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:4px;padding:2px 6px;font-size:0.55em;color:var(--gold);font-weight:800;font-family:'Orbitron',sans-serif">✅ ×${owned}</div>` : ''}
</div>
<div class="car-card-info">
    <div class="car-card-name" style="color:${u.tierColor}">${u.nombre}</div>
    ${u.fisico ? `<div style="font-size:0.74em;color:var(--green);margin:3px 0;font-weight:700">💪 ${u.fisico.toLocaleString()} pts físico</div>` : `<div style="font-size:0.74em;color:var(--cyan);margin:3px 0;font-weight:700">⭐ ${u.bonus}</div>`}
    <div class="car-card-price" style="color:${u.tierColor}">💎 ${u.precio.toLocaleString()}</div>
    <button class="buy-car-btn" onclick="comprarUniforme('${u.id}')"
        style="border-color:${u.tierBorder};color:${u.tierColor};"
        ${gemas < u.precio ? 'disabled' : ''}>
        👕 Comprar
    </button>
</div>
</div>`;
        }).join('');
    }

    function comprarUniforme(id) {
        const u = UNIFORMES.find(x => x.id === id);
        if (!u) return;
        if (gemas < u.precio) { mostrarMensaje(`❌ Faltan ${(u.precio - gemas).toFixed(1)} 💎`, '#ff4444'); return; }
        gemas -= u.precio;
        _uniformesComprados[id] = (_uniformesComprados[id] || 0) + 1;
        if (u.fisico) { hp += u.fisico; puntaje += Math.round(u.fisico / 10); }
        if(typeof saveState==='function') saveState();
        actualizarUI();
        buildUniforms();
        if(typeof buildGarageInventory==='function') buildGarageInventory();
        mostrarMensaje(`✅ ${u.nombre} añadido a tu inventario! ${u.fisico ? `+${u.fisico.toLocaleString()} pts físico` : u.bonus} · Asígnalo desde Mi Plantilla`, '#00ff88');
    }

    // ── LOGROS DE HABILIDADES ─────────────────────────────────────────────
    function getSkillClaimedKey(skillId, milestone) {
        return `skill_${skillId}_m${milestone}`;
    }
    function getSkillClaimedData() {
        return JSON.parse(localStorage.getItem(_pfx()+'_skill_claimed')||'{}');
    }
    function saveSkillClaimedData(data) {
        localStorage.setItem(_pfx()+'_skill_claimed', JSON.stringify(data));
    }

    function addSkillCount(skillId, amount=1) {
        if(!skillCounts[skillId]) skillCounts[skillId]=0;
        skillCounts[skillId]+=amount;
        saveState();
        buildSkillLogros();
        actualizarUI();
    }

    function claimSkillMilestone(skillId, milestone) {
        const claimed = getSkillClaimedData();
        const key = getSkillClaimedKey(skillId, milestone);
        if(claimed[key]) { mostrarMensaje('✅ Ya reclamado','#888'); return; }
        const count = skillCounts[skillId]||0;
        if(count < milestone) { mostrarMensaje('⚠️ Aún no alcanzas este hito','#ffaa00'); return; }
        const gems = getSkillMilestoneGems(milestone);
        gemas += gems;
        puntaje += 100;
        claimed[key] = true;
        saveSkillClaimedData(claimed);
        if(typeof saveState==='function') saveState();
        actualizarUI();
        buildSkillLogros();
        mostrarMensaje(`🏅 +${gems} 💎 y +100 pts por ${milestone} acciones!`, '#ffd700');
    }

    function buildSkillLogros() {
        const grid = $id('logros-skill-grid');
        if(!grid) return;
        const claimed = getSkillClaimedData();

        let totalAcciones = 0;
        let totalGemsEarned = 0;
        let totalPtsEarned = 0;

        SKILLS.forEach(sk => {
            totalAcciones += (skillCounts[sk.id]||0);
            SKILL_MILESTONES.forEach(m => {
                const key = getSkillClaimedKey(sk.id, m);
                if(claimed[key]) {
                    totalGemsEarned += getSkillMilestoneGems(m);
                    totalPtsEarned += 100;
                }
            });
        });

        // Update totals
        const ltA=$id('lt-total-acciones');if(ltA)ltA.textContent=totalAcciones.toLocaleString();
        const ltG=$id('lt-total-gems');if(ltG)ltG.textContent=totalGemsEarned;
        const ltP=$id('lt-total-pts');if(ltP)ltP.textContent=totalPtsEarned;

        grid.innerHTML = SKILLS.map(sk => {
            const count = skillCounts[sk.id]||0;
            const maxMilestone = 1000;
            const pct = Math.min(100, Math.round((count % 100) / 100 * 100));
            const nextMilestone = Math.min(maxMilestone, Math.ceil((count+1)/100)*100);
            const progressToNext = count >= maxMilestone ? 100 : Math.round(((count % 100)) / 100 * 100);

            const milestonesHtml = SKILL_MILESTONES.map(m => {
                const key = getSkillClaimedKey(sk.id, m);
                const isClaimed = !!claimed[key];
                const isAchieved = count >= m;
                const isClaimable = isAchieved && !isClaimed;
                const gems = getSkillMilestoneGems(m);

                let cls = 'logro-skill-milestone locked';
                let label = `${m}`;
                let onclick = '';
                if(isClaimed) { cls='logro-skill-milestone claimed'; label=`${m}✓`; }
                else if(isClaimable) { cls='logro-skill-milestone claimable'; label=`${m} +${gems}💎`; onclick=`onclick="claimSkillMilestone('${sk.id}',${m})"` }
                else if(isAchieved) { cls='logro-skill-milestone achieved'; label=`${m} +${gems}💎`; onclick=`onclick="claimSkillMilestone('${sk.id}',${m})"` }

                return `<span class="${cls}" ${onclick} title="${m} acciones = +${gems}💎 +100pts">${label}</span>`;
            }).join('');

            const hasClaimable = SKILL_MILESTONES.some(m => {
                const key = getSkillClaimedKey(sk.id, m);
                return count >= m && !claimed[key];
            });

            return `<div class="logro-skill-card ${count>0?'desbloqueado':''}">
<div class="logro-skill-header">
    <span class="logro-skill-icon">${sk.icon}</span>
    <div>
        <div class="logro-skill-title">${sk.nombre}</div>
        <div class="logro-skill-pos">${sk.cat} · ${sk.desc}</div>
    </div>
    <div class="logro-skill-count">${count.toLocaleString()}</div>
</div>
<div class="logro-skill-bar-wrap">
    <div style="display:flex;justify-content:space-between;font-size:0.68em;color:#555;margin-bottom:4px">
        <span style="color:${count>0?'var(--green)':'#444'}">${count} realizadas</span>
        <span>próx. hito: ${count>=1000?'MAX':nextMilestone}</span>
    </div>
    <div class="logro-skill-bar-bg">
        <div class="logro-skill-bar-fill" style="width:${count>=1000?100:Math.round((count%100)/100*100)}%"></div>
    </div>
</div>
<div class="logro-skill-milestones">${milestonesHtml}</div>
<button class="logro-skill-add-btn" onclick="addSkillCount('${sk.id}',1)">
    ${hasClaimable ? '⚡ Hito listo — ¡Reclama arriba!' : `+ Registrar ${sk.nombre}`}
</button>
</div>`;
        }).join('');
    }

    // ── GARAGE ────────────────────────────────────────────────────────────
    function buildGarage(){
        let html='';let slotNum=0;
        for(const entry of carrosComprados){
            for(let copy=0;copy<entry.qty&&slotNum<20;copy++,slotNum++){
                const c=PLAYERS[entry.idx];const isSelected=_selectedSquadSlot&&_selectedSquadSlot.idx===entry.idx&&_selectedSquadSlot.copy===copy;
                const eq=getSlotEquip(entry.idx,copy);const ovrTotal=getSlotOVR(entry.idx,copy);const hasFullEquip=!!(eq.uniforme&&eq.tenis&&eq.protector);
                html+=`<div class="squad-slot occupied${isSelected?' selected':''}" onclick="selectSquadSlot(${entry.idx},${copy})" style="${isSelected?'border-color:var(--cyan);box-shadow:0 0 14px rgba(0,212,255,0.4)':''}">
<img src="${playerImgSrc(entry.idx)}" alt="${c.nombre}" onerror="this.onerror=null;this.src='${playerImgFallback(c).replace(/'/g,"\\'")}'" style="width:100%;height:100%;object-fit:cover;display:block">
${hasFullEquip?`<div style="position:absolute;top:5px;left:5px;background:linear-gradient(135deg,var(--gold),var(--orange));color:#111;border:1px solid rgba(255,255,255,0.75);border-radius:999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:0.82em;box-shadow:0 0 14px rgba(255,216,77,0.8);z-index:2" title="NFT completo equipado">⭐</div>`:''}
<div class="squad-slot-overlay"><div class="squad-slot-name">${c.nombre}</div><div class="squad-slot-ovr">OVR ${ovrTotal}${ovrTotal>c.hp?` <span style="color:var(--green)">(+${ovrTotal-c.hp})</span>`:''}</div></div>
${entry.qty>1?`<div class="squad-slot-qty">#${copy+1}</div>`:''}
</div>`;
            }
        }
        while(slotNum<20){html+=`<div class="squad-slot" onclick="closeModal('modal-garage');openModal('modal-marketplace')"><div class="squad-slot-empty-icon">➕</div><div style="font-size:0.55em;color:#333">Slot ${slotNum+1}</div></div>`;slotNum++;}
        $id('garage-grid-vehicles').innerHTML=html;
        updateEquipPanel();
        buildGarageInventory();
    }
    function selectSquadSlot(idx,copy){_selectedSquadSlot={idx,copy};buildGarage();}

    // ── INVENTARIO EN GARAGE (Uniformes / Tenis / Entrenadores) ──────────
    function buildGarageInventory(){
        // UNIFORMES
        const gu = $id('garage-grid-uniformes');
        if(gu){
            const owned = UNIFORMES.filter(u => (_uniformesComprados[u.id]||0) > 0);
            if(owned.length===0){
                gu.innerHTML = `<div class="inv-empty-hint" style="grid-column:1/-1">👕 Aún no tienes uniformes.<br>Cómpralos en el <strong style="color:var(--green)">Marketplace → Uniformes</strong>.</div>`;
            } else {
                gu.innerHTML = owned.map(u => `
                    <div class="car-card" style="border-color:${u.tierBorder};background:${u.tierBg};">
                        <div class="car-card-img-wrap">
                            <img class="car-card-img" src="${u.img}" alt="${u.nombre}" onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex';" style="object-fit:cover;aspect-ratio:3/4;">
                            <div style="display:none;width:100%;aspect-ratio:3/4;align-items:center;justify-content:center;font-size:3.5em;background:#0a130a;">${u.emoji}</div>
                            <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:6px;padding:2px 7px;font-size:0.6em;color:var(--gold);font-weight:800">×${_uniformesComprados[u.id]}</div>
                        </div>
                        <div class="car-card-info">
                            <div class="car-card-name" style="color:${u.tierColor}">${u.nombre}</div>
                            <div style="font-size:0.7em;color:var(--green);margin:3px 0;font-weight:700">${u.fisico?`💪 +${u.fisico} físico`:`⭐ ${u.bonus}`}</div>
                            <button class="buy-car-btn" onclick="quickAssignFromInventory('uniforme','${u.id}')" style="border-color:${u.tierBorder};color:${u.tierColor}">⚙️ Asignar</button>
                        </div>
                    </div>`).join('');
            }
        }
        // ZAPATILLAS
        const gt = $id('garage-grid-tenis');
        if(gt){
            const owned = ZAPATILLAS.map((it,i)=>({it,i,qty:getItemQty('tenis',i)})).filter(x=>x.qty>0);
            if(owned.length===0){
                gt.innerHTML = `<div class="inv-empty-hint" style="grid-column:1/-1">👟 Aún no tienes zapatillas.<br>Cómpralas en el <strong style="color:var(--green)">Marketplace → Tenis</strong>.</div>`;
            } else {
                gt.innerHTML = owned.map(({it,i,qty})=>`
                    <div class="car-card">
                        <div class="car-card-img-wrap">
                            <img class="car-card-img" src="${itemImgUrl(it.img)}" alt="${it.nombre}" onerror="this.onerror=null;this.src=&quot;${itemFallback(it)}&quot;" style="object-fit:cover">
                            <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:6px;padding:2px 7px;font-size:0.6em;color:var(--gold);font-weight:800">×${qty}</div>
                        </div>
                        <div class="car-card-info">
                            <div class="car-card-name">${it.nombre}</div>
                            <div style="font-size:0.7em;color:var(--green);margin:3px 0;font-weight:700">⚡ +${it.bonus}% rendimiento</div>
                            <button class="buy-car-btn" onclick="quickAssignFromInventory('tenis','${i}')">⚙️ Asignar</button>
                        </div>
                    </div>`).join('');
            }
        }
        // ENTRENADORES
        const ge = $id('garage-grid-entrenadores');
        if(ge){
            const owned = ENTRENADORES.map((it,i)=>({it,i,qty:getItemQty('entrenador',i)})).filter(x=>x.qty>0);
            if(owned.length===0){
                ge.innerHTML = `<div class="inv-empty-hint" style="grid-column:1/-1">🏋️ Aún no tienes entrenadores.<br>Cómpralos en el <strong style="color:var(--green)">Marketplace → Entrenadores</strong>.</div>`;
            } else {
                ge.innerHTML = owned.map(({it,i,qty})=>`
                    <div class="car-card">
                        <div class="car-card-img-wrap">
                            <img class="car-card-img" src="${itemImgUrl(it.img)}" alt="${it.nombre}" onerror="this.onerror=null;this.src=&quot;${itemFallback(it)}&quot;" style="object-fit:cover">
                            <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:6px;padding:2px 7px;font-size:0.6em;color:var(--gold);font-weight:800">×${qty}</div>
                        </div>
                        <div class="car-card-info">
                            <div class="car-card-name">${it.nombre}</div>
                            <div style="font-size:0.7em;color:var(--green);margin:3px 0;font-weight:700">${it.flag} +${it.bonus}% bonus</div>
                            <button class="buy-car-btn" onclick="quickAssignFromInventory('protector','${i}')">⚙️ Asignar</button>
                        </div>
                    </div>`).join('');
            }
        }
    }
    function quickAssignFromInventory(type, id){
        // Cambia a tab Futbolistas y abre el picker enfocado
        if(!_selectedSquadSlot){
            switchTabById('garage','vehiculos');
            mostrarMensaje('⚠️ Primero selecciona un futbolista en la pestaña Futbolistas','#ffaa00');
            return;
        }
        switchTabById('garage','vehiculos');
        openEquipModal(type);
    }
    function switchTabById(group, name){
        document.querySelectorAll(`#modal-${group} .tab-btn`).forEach(b=>b.classList.remove('active'));
        document.querySelectorAll(`#modal-${group} .tab-panel`).forEach(p=>p.classList.remove('active'));
        const panel = document.getElementById(`${group}-${name}`); if(panel) panel.classList.add('active');
        // Active button
        const btns = document.querySelectorAll(`#modal-${group} .tab-btn`);
        btns.forEach(b=>{ if(b.getAttribute('onclick')&&b.getAttribute('onclick').includes(`'${name}'`)) b.classList.add('active'); });
    }
    function updateEquipPanel(){
        const preview=$id('equip-preview');const nameEl=$id('equip-player-name');
        if(!_selectedSquadSlot){preview.innerHTML='<div class="equipment-player-placeholder">🧑</div>';nameEl.textContent='Selecciona un jugador';$id('eb-ovr').textContent='0';$id('eb-spd').textContent='+0%';$id('eb-def').textContent='+0%';$id('eb-gems').textContent='—';return;}
        const{idx,copy}=_selectedSquadSlot;const c=PLAYERS[idx];const key=slotKey(idx,copy);const eq=_equipamiento[key]||{};
        const ovrTotal=getSlotOVR(idx,copy);
        preview.innerHTML=`<div style="position:relative;width:100%;height:100%"><img class="equipment-player-img" src="${playerImgSrc(idx)}" alt="${c.nombre}" onerror="this.onerror=null;this.src='${playerImgFallback(c).replace(/'/g,"\\'")}'">${(eq.uniforme&&eq.tenis&&eq.protector)?`<div style="position:absolute;top:8px;left:8px;background:linear-gradient(135deg,var(--gold),var(--orange));color:#111;border-radius:999px;padding:4px 8px;font-size:0.75em;font-weight:900;box-shadow:0 0 16px rgba(255,216,77,0.75)">⭐ NFT PRO</div>`:''}</div>`;
        nameEl.textContent=`${c.flag} ${c.nombre}${copy>0?' #'+(copy+1):''} · OVR ${ovrTotal}${ovrTotal>c.hp?' (+'+(ovrTotal-c.hp)+')':''}`;
        ['uniforme','tenis','protector'].forEach(type=>{
            const slotEl=$id(`equip-slot-${type}`);const nameSlotEl=$id(`equip-${type}-name`);
            const equipped = eq[type];
            if(equipped){
                slotEl.classList.add('equipped');
                nameSlotEl.textContent = equipped.nombre || equipped;
                nameSlotEl.style.color='var(--green)';
            } else {
                slotEl.classList.remove('equipped');
                nameSlotEl.textContent='— Vacío —';
                nameSlotEl.style.color='#555';
            }
        });
        // Calcular bonos a partir de items reales
        const bonuses=getEquipBonuses(eq);
        $id('eb-ovr').textContent=c.hp + bonuses.spd + bonuses.def + bonuses.phy;
        $id('eb-spd').textContent=`+${bonuses.spd}%`;$id('eb-def').textContent=`+${bonuses.def}%`;
        $id('eb-gems').textContent=`${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎/día`;
    }

    // ── PICKER DE EQUIPAMIENTO ────────────────────────────────────────────
    let _equipPickerType = null;
    function openEquipModal(type){
        if(!_selectedSquadSlot){ mostrarMensaje('⚠️ Selecciona un jugador primero','#ffaa00'); return; }
        _equipPickerType = type;
        const titleMap = { uniforme:'👕 Asignar Uniforme', tenis:'👟 Asignar Zapatillas', protector:'🏋️ Asignar Entrenador' };
        $id('equip-picker-title').textContent = titleMap[type] || '⚙️ Equipamiento';
        const {idx, copy} = _selectedSquadSlot;
        const c = PLAYERS[idx];
        $id('equip-picker-subtitle').textContent = `Para: ${c.flag} ${c.nombre}${copy>0?' #'+(copy+1):''}`;
        renderEquipPicker(type);
        $id('modal-equip-picker').classList.add('active');
    }
    function renderEquipPicker(type){
        const key = slotKey(_selectedSquadSlot.idx, _selectedSquadSlot.copy);
        const eq = _equipamiento[key] || {};
        const currentId = eq[type] && (eq[type].id != null ? String(eq[type].id) : null);
        let cards = [];
        if(type === 'uniforme'){
            UNIFORMES.forEach(u => {
                const qty = _uniformesComprados[u.id] || 0;
                if(qty > 0) cards.push({
                    id: u.id, name: u.nombre, bonusText: u.fisico?`💪 +${u.fisico} físico`:`⭐ ${u.bonus}`,
                    img: u.img, qty, fallbackEmoji: u.emoji
                });
            });
        } else if(type === 'tenis'){
            ZAPATILLAS.forEach((it, i) => {
                const qty = getItemQty('tenis', i);
                if(qty > 0) cards.push({ id: String(i), name: it.nombre, bonusText: `⚡ +${it.bonus}% velocidad`, img: itemImgUrl(it.img), qty, fallbackImg: itemFallback(it) });
            });
        } else if(type === 'protector'){
            ENTRENADORES.forEach((it, i) => {
                const qty = getItemQty('entrenador', i);
                if(qty > 0) cards.push({ id: String(i), name: it.nombre, bonusText: `${it.flag} +${it.bonus}% bonus`, img: itemImgUrl(it.img), qty, fallbackImg: itemFallback(it) });
            });
        }
        const wrap = $id('equip-picker-content');
        if(cards.length === 0){
            const linkTxt = type==='uniforme'?'Uniformes':type==='tenis'?'Tenis':'Entrenadores';
            wrap.innerHTML = `<div class="equip-picker-empty">📦 No tienes ${linkTxt} en tu inventario.<br><br>Ve al <strong style="color:var(--green)">Marketplace → ${linkTxt}</strong> para comprarlos.</div>`;
            return;
        }
        wrap.innerHTML = `<div class="equip-picker-grid">${cards.map(c => {
            const isEq = currentId === c.id;
            const fallback = c.fallbackImg ? `onerror="this.onerror=null;this.src='${c.fallbackImg.replace(/'/g,"\\'")}'"` : `onerror="this.onerror=null;this.style.display='none';this.parentElement.innerHTML+='<div style=&quot;font-size:3em;padding:20px&quot;>${c.fallbackEmoji||'🎁'}</div>'"`;
            return `<div class="equip-picker-card ${isEq?'is-equipped':''}" onclick="assignEquip('${c.id}')">
                <div style="position:relative">
                    <img src="${c.img}" alt="${c.name}" ${fallback}>
                    <div class="epc-badge">×${c.qty}</div>
                    ${isEq?`<div style="position:absolute;bottom:6px;left:6px;background:var(--gold);color:#000;border-radius:6px;padding:2px 6px;font-size:0.6em;font-weight:800">EQUIPADO</div>`:''}
                </div>
                <div class="epc-name">${c.name}</div>
                <div class="epc-bonus">${c.bonusText}</div>
            </div>`;
        }).join('')}</div>`;
    }
    function assignEquip(id){
        if(!_selectedSquadSlot || !_equipPickerType) return;
        const key = slotKey(_selectedSquadSlot.idx, _selectedSquadSlot.copy);
        if(!_equipamiento[key]) _equipamiento[key] = {};
        let item = null;
        if(_equipPickerType === 'uniforme'){
            const u = UNIFORMES.find(x => x.id === id);
            if(u) item = { id: u.id, nombre: u.nombre, fisico: u.fisico, bonus: 0 };
        } else if(_equipPickerType === 'tenis'){
            const it = ZAPATILLAS[parseInt(id,10)];
            if(it) item = { id: id, nombre: it.nombre, bonus: it.bonus };
        } else if(_equipPickerType === 'protector'){
            const it = ENTRENADORES[parseInt(id,10)];
            if(it) item = { id: id, nombre: it.nombre, bonus: it.bonus };
        }
        if(!item) return;
        _equipamiento[key][_equipPickerType] = item;
        if(typeof saveState==='function') saveState();
        updateEquipPanel();
        renderEquipPicker(_equipPickerType);
        mostrarMensaje(`✅ ${item.nombre} equipado`,'#00ff88');
        setTimeout(()=>closeEquipPicker(), 600);
    }
    function clearEquipSlot(){
        if(!_selectedSquadSlot || !_equipPickerType) return;
        const key = slotKey(_selectedSquadSlot.idx, _selectedSquadSlot.copy);
        if(_equipamiento[key] && _equipamiento[key][_equipPickerType]){
            delete _equipamiento[key][_equipPickerType];
            if(typeof saveState==='function') saveState();
            updateEquipPanel();
            renderEquipPicker(_equipPickerType);
            mostrarMensaje(`🗑️ Equipamiento removido`,'#ffaa00');
        }
    }
    function closeEquipPicker(){
        const m = $id('modal-equip-picker'); if(m) m.classList.remove('active');
        _equipPickerType = null;
    }

    // ── PLAYER DETAIL ─────────────────────────────────────────────────────
    function openCarDetail(idx,fromGarage,copy=0){
        const c=PLAYERS[idx];const dur=getDurabilidad(idx,copy);const durCls=colorDurabilidad(dur);const balls=getBallonesJugador(idx,copy);const fuelLlenos=balls.filter(Boolean).length;const playerId=generatePlayerId(idx,copy);
        $id('car-detail-img').src=playerImgSrc(idx);$id('car-detail-name').textContent=c.nombre;$id('car-detail-country-flag').textContent=c.flag+' '+c.pais;$id('car-detail-player-id').textContent='ID: '+playerId;
        const _free = isFreeNFT(idx);
        const _cap = getBalonesCapacidad(idx);
        // En el fichero del NFT FREE: ocultar OVR, balones y stats; mostrar SOLO la generación de gemas
        $id('car-detail-hp').textContent = _free ? '—' : (c.hp+' OVR');
        $id('car-detail-dur').textContent=dur+'%';$id('car-detail-dur').style.color=dur>=60?'var(--green)':dur>=30?'var(--gold)':'var(--red)';
        $id('car-detail-fuel').textContent = _free ? `${fuelLlenos} / ${_cap}` : (fuelLlenos+' / 4');
        $id('car-detail-earn').textContent = _free
            ? `🎁 ${c.freeGemasTotal} 💎`
            : `${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎/día`;
        if(_free){
            // En las estadísticas extra: SOLO mostrar la generación de 160 💎; ocultar velocidad/defensa/físico
            $id('car-detail-extra-stats').innerHTML = `
<div style="grid-column:1/-1;background:linear-gradient(135deg,rgba(66,245,141,0.10),rgba(255,216,77,0.08));border:1px solid var(--green);border-radius:10px;padding:14px;text-align:center">
    <div style="font-size:1.6em">🎁</div>
    <div style="font-size:0.7em;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-top:4px">NFT FREE · 1 por wallet</div>
    <div style="font-family:'Orbitron',sans-serif;font-size:1.15em;color:var(--green);font-weight:800;margin-top:6px">${c.freeGemasTotal} 💎</div>
    <div style="font-size:0.72em;color:#888;margin-top:4px">⚽ ${_cap} balones cada 24h</div>
</div>`;
        } else {
            const spd=Math.round(c.hp*0.9+3),def=Math.round(c.hp*0.6+5),phy=Math.round(c.hp*0.75+4);
            $id('car-detail-extra-stats').innerHTML=`
<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px;text-align:center"><div style="font-size:1.2em">⚡</div><div style="font-size:0.68em;color:#888;text-transform:uppercase">Velocidad</div><div style="font-family:'Orbitron',sans-serif;font-size:0.95em;color:var(--cyan);font-weight:700">${spd}</div></div>
<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px;text-align:center"><div style="font-size:1.2em">🛡️</div><div style="font-size:0.68em;color:#888;text-transform:uppercase">Defensa</div><div style="font-family:'Orbitron',sans-serif;font-size:0.95em;color:var(--orange);font-weight:700">${def}</div></div>
<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px;text-align:center"><div style="font-size:1.2em">💪</div><div style="font-size:0.68em;color:#888;text-transform:uppercase">Físico</div><div style="font-family:'Orbitron',sans-serif;font-size:0.95em;color:var(--purple);font-weight:700">${phy}</div></div>`;
        }
        $id('car-detail-dur-bar').innerHTML=`<div style="display:flex;justify-content:space-between;font-size:0.78em;color:#888;margin-bottom:5px"><span>💪 Forma Física</span><span style="color:${dur>=60?'var(--green)':dur>=30?'var(--gold)':'var(--red)'}">${dur}%</span></div><div style="background:rgba(255,255,255,0.07);border-radius:50px;height:8px;overflow:hidden"><div class="dur-bar-fill ${durCls}" style="width:${dur}%"></div></div>`;
        const idHtml=`<div style="background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.2);border-radius:8px;padding:8px 14px;margin-bottom:12px;font-size:0.8em;color:#888">🆔 <strong style="color:var(--cyan);font-family:'Orbitron',sans-serif">${playerId}</strong></div>`;
        if(fromGarage){$id('car-detail-action-btn').innerHTML=idHtml+`<button class="primary-btn" style="font-size:0.82em" onclick="closeCarDetail();openModal('modal-mantenimiento')">🏋️ Ir a Entrenamiento</button>`;}
        else{
            const owned=getPlayerQty(idx);
            if(_free){
                const walletAddr=currentWalletAddr();
                const claimed = owned>0 || hasWalletClaimedFreeNFT(idx, walletAddr);
                const btn = claimed
                    ? `<button class="primary-btn" style="font-size:0.82em;opacity:0.6;cursor:default">✅ Ya reclamado (1/wallet)</button>`
                    : (walletAddr
                        ? `<button class="primary-btn" style="font-size:0.82em;background:linear-gradient(135deg,#42f58d,#ffd84d);color:#000" onclick="closeCarDetail();reclamarFreeNFT(${idx})">🎁 Reclamar Gratis</button>`
                        : `<button class="primary-btn" style="font-size:0.82em;opacity:0.7" onclick="closeCarDetail();openWalletModal&&openWalletModal()">🔒 Conecta tu wallet</button>`);
                $id('car-detail-action-btn').innerHTML=idHtml+btn;
            } else {
                const remaining=MAX_PER_PLAYER-owned;
                $id('car-detail-action-btn').innerHTML=idHtml+(remaining>0?`<button class="primary-btn" style="font-size:0.82em" onclick="closeCarDetail();openModal('modal-marketplace')">💎 Ver en Marketplace (${owned}/${MAX_PER_PLAYER})</button>`:`<button class="primary-btn" style="font-size:0.82em;opacity:0.5;cursor:default">✅ Máximo alcanzado</button>`);
            }
        }
        $id('modal-car-detail').classList.add('active');document.body.style.overflow='hidden';
    }
    function closeCarDetail(){$id('modal-car-detail').classList.remove('active');document.body.style.overflow='';}
    $id('modal-car-detail').addEventListener('click',e=>{if(e.target===$id('modal-car-detail'))closeCarDetail();});

    // ── SELECTOR JUGADOR ──────────────────────────────────────────────────
    function abrirSeleccionJugadorPVP(modo){_pvpModeSelected=modo;_currentMatchMode='pvp';abrirModalSeleccionJugador('pvp');}
    function abrirSeleccionJugadorFutsala(cancha){_currentMatchCancha=cancha;_currentMatchMode='pve';abrirModalSeleccionJugador('pve');}
    function abrirModalSeleccionJugador(mode){
        if(carrosComprados.length===0){mostrarMensaje('⚠️ ¡Ficha un futbolista primero!','#ffaa00');return;}
        $id('select-player-desc').textContent=mode==='pve'?'Selecciona el jugador para Futsala.':'Selecciona el jugador para FutCancha PVP.';
        $id('select-player-error').textContent='';
        const diffSelect=$id('match-difficulty');
        diffSelect.style.display=mode==='pve'?'block':'none';
        const grid=$id('player-select-grid');let html='';
        carrosComprados.forEach(entry=>{
            for(let copy=0;copy<entry.qty;copy++){
                const c=PLAYERS[entry.idx];const balls=getBallonesJugador(entry.idx,copy);const llenos=balls.filter(Boolean).length;const hasBall=llenos>0;
                const isSelected=_currentMatchPlayer&&_currentMatchPlayer.idx===entry.idx&&_currentMatchPlayer.copy===copy;
                const ovrTotal=getSlotOVR(entry.idx,copy);
                html+=`<div class="player-select-card${isSelected?' selected':''}" onclick="${hasBall?`selectPlayerForMatch(${entry.idx},${copy})`:`mostrarMensaje('⚽ Sin balones','#ffaa00')`}" style="${hasBall?'':'opacity:0.45;cursor:not-allowed'}">
<img src="${playerImgSrc(entry.idx)}" alt="${c.nombre}" onerror="this.onerror=null;this.src='${playerImgFallback(c).replace(/'/g,"\\'")}'" style="width:100%;aspect-ratio:3/4;object-fit:cover">
<div class="player-select-info">
    <h5>${c.nombre}${entry.qty>1?' #'+(copy+1):''}</h5>
    <div class="ps-ovr">⚡ OVR ${ovrTotal}${ovrTotal>c.hp?` (+${ovrTotal-c.hp})`:''}</div>
    <div style="font-size:0.7em;color:var(--gold);margin-top:1px">📈 ${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎</div>
    <div class="ps-balls">${llenos>0?`⚽ ${llenos}`:'💤 Sin balones'}</div>
</div>
</div>`;
            }
        });
        grid.innerHTML=html;
        openModal('modal-select-player');
    }
    function selectPlayerForMatch(idx,copy=0){_currentMatchPlayer={idx,copy};abrirModalSeleccionJugador(_currentMatchMode);}
    function confirmarJugadorYJugar(){
        if(!_currentMatchPlayer){$id('select-player-error').textContent='⚠️ Elige un jugador primero';return;}
        const{idx,copy}=_currentMatchPlayer;const balls=getBallonesJugador(idx,copy);
        if(!balls.some(Boolean)){$id('select-player-error').textContent='❌ Sin balones';return;}
        if(_currentMatchMode==='pve'){const diffMap={barrial:'Cancha Barrial',municipal:'Estadio Municipal',copa:'Copa del Mundo',gala:'Noche de Gala'};_currentMatchCancha=diffMap[$id('match-difficulty').value]||'Cancha Barrial';}
        closeModal('modal-select-player');
        consumirBalonJugador(idx,copy);reducirDurabilidad(idx,copy);actualizarUI();
        iniciarVideoPartida();
    }

    // ── VIDEO PARTIDO — JUEGO INTERACTIVO ────────────────────────────────
    let _matchAnimFrame=null;
    let _gameState=null;

    // Nombres y países random de oponentes
    const OPP_NAMES=['ProKick_99','FutMaster','GoalHunter','DribleKing','TigreVerde','ElCañonero','ReyDelGol','LoboCelebre','AstroFut','RapidoFC'];
    const OPP_FLAGS=['🇧🇷','🇦🇷','🇫🇷','🇩🇪','🇵🇹','🇪🇸','🇮🇹','🇳🇱','🇨🇴','🇲🇽'];
    function randomOpp(){
        const n=OPP_NAMES[Math.floor(Math.random()*OPP_NAMES.length)];
        const f=OPP_FLAGS[Math.floor(Math.random()*OPP_FLAGS.length)];
        return{nombre:n,flag:f,id:'OPP-'+Math.floor(100000+Math.random()*899999)};
    }

    function showScreen(name){
        const flexScreens={'match-intro-screen':true,'match-game-screen':true,'match-result-screen':true};
        Object.keys(flexScreens).forEach(id=>{
            const el=$id(id);if(!el)return;
            el.style.display = el.id===name ? 'flex' : 'none';
        });
    }

    function iniciarVideoPartida(){
        const overlay=$id('video-overlay');
        overlay.classList.add('active');
        document.body.style.overflow='hidden';

        const{idx,copy}=_currentMatchPlayer;
        const player=PLAYERS[idx];
        const nftId=generatePlayerId(idx,copy);
        const opp=randomOpp();

        // Calcular resultado final (predeterminado, el juego lo ajusta)
        let winChance=0.55+nivelWinBonus();
        if(_currentMatchMode==='pve'){
            const dm={'Cancha Barrial':0.72,'Estadio Municipal':0.58,'Copa del Mundo':0.44,'Noche de Gala':0.36};
            winChance=Math.min(0.92,(dm[_currentMatchCancha]||0.55)+nivelWinBonus());
        }
        // Goles base del partido, el jugador puede sumar con sus disparos
        const baseOppGoals=Math.floor(Math.random()*3);
        const basePlayerGoals=Math.random()<winChance?baseOppGoals+Math.floor(Math.random()*2):Math.max(0,baseOppGoals-1);

        // Estado del juego
        _gameState={
            idx,copy,player,nftId,opp,
            playerGoals:0, oppGoals:0,
            basePlayerGoals, baseOppGoals,
            winChance,
            playerShots:0, playerShotsOnTarget:0,
            yellowCards:0, redCards:0, corners:0, saves:0, throwIns:0, penalties:0, goalKicks:0,
            matchTime:0, maxTime:90,
            teamPlayers:[],
            phase:'intro', // intro → playing → result
            // Pelota
            bx:0,by:0,bvx:0,bvy:0,
            // Porteros (posición del arco que defiende el oponente)
            gkY:0,gkTargetY:0,
            // Input
            keys:{},
            // Tiro activo
            shooting:false, shotCooldown:0,
            // Jugador controlado
            px:0,py:0,
            // Jugadores IA equipo rival
            aiPlayers:[],
            // Eventos de gol (texto flotante)
            goalEvents:[],
            matchEventSchedule:[],
            // Resolución del canvas
            cw:0,ch:0,
            // Oponentes marcadores programados (para no quedarse en 0-0)
            oppScoreAt: baseOppGoals>0 ? Array.from({length:baseOppGoals},(_,i)=>Math.floor(20+i*25)) : [],
            playerBaseScoreAt: basePlayerGoals>0 ? Array.from({length:basePlayerGoals},(_,i)=>Math.floor(15+i*22)) : [],
        };

        // ── INTRO ────────────────────────────────────────────────────────
        showScreen('match-intro-screen');

        // Rellenar datos de intro
        const isCancha=_currentMatchMode==='futcancha'||_currentMatchMode==='pvp';
        $id('intro-mode-label').textContent = isCancha ? '🏟️ FUTCANCHA PVP' : `⚽ FUTSALA · ${_currentMatchCancha||'Cancha Barrial'}`;
        $id('intro-a-name').textContent = player.nombre.split(' ')[0].toUpperCase();
        $id('intro-a-id').textContent = 'ID: '+nftId;
        $id('intro-a-ovr').textContent = '⚡ OVR '+getSlotOVR(idx,copy);
        $id('intro-a-badge').style.background = (player.color1||'#1a6a1a');
        $id('intro-a-badge').style.borderColor = (player.color1||'var(--green)');
        $id('intro-a-badge').textContent = player.flag||'⚽';

        $id('intro-b-name').textContent = opp.nombre.toUpperCase();
        $id('intro-b-id').textContent = 'ID: '+opp.id;
        $id('intro-b-ovr').textContent = opp.flag;
        $id('intro-b-badge').textContent = opp.flag;
        $id('intro-cancha-label').textContent = isCancha ? '⚡ MODO PVP · TIEMPO REAL' : `🏟️ ${_currentMatchCancha||'Cancha Barrial'} · MODO LIBRE`;

        // Animación de entrada
        setTimeout(()=>{
            $id('intro-team-a').style.opacity='1';
            $id('intro-team-a').style.transform='translateX(0)';
        },80);
        setTimeout(()=>{
            $id('intro-team-b').style.opacity='1';
            $id('intro-team-b').style.transform='translateX(0)';
        },200);
        setTimeout(()=>{
            $id('intro-vs').style.opacity='1';
            $id('intro-vs').style.transform='scale(1)';
        },500);

        // Countdown 3-2-1 luego arrancar
        const cdEl=$id('intro-countdown');
        let cd=3;
        setTimeout(()=>{
            $id('intro-vs').style.display='none';
            cdEl.style.display='block';
            const tick=()=>{
                cdEl.textContent=cd;
                cdEl.style.transform='scale(1.4)';
                cdEl.style.opacity='1';
                setTimeout(()=>{cdEl.style.transform='scale(0.8)';cdEl.style.opacity='0.3';},350);
                cd--;
                if(cd>=0)setTimeout(tick,700);
                else setTimeout(()=>{ cdEl.style.display='none'; iniciarJuegoInteractivo(); },400);
            };
            tick();
        },1200);
    }

    function iniciarJuegoInteractivo(){
        const gs=_gameState;
        showScreen('match-game-screen');

        const canvas=$id('match-canvas');
        // Ajustar resolución real al tamaño visual
        const rect=canvas.getBoundingClientRect();
        const W=Math.min(640,window.innerWidth);
        // Altura: el canvas ocupa el espacio disponible menos HUD y controles
        const hudH=36, ctrlH=128;
        const H=Math.max(220,window.innerHeight-hudH-ctrlH);
        canvas.width=W; canvas.height=H;
        const ctx=canvas.getContext('2d');

        gs.cw=W; gs.ch=H;
        gs.bx=W/2; gs.by=H/2; gs.bvx=0; gs.bvy=0;
        gs.px=W*0.22; gs.py=H/2;
        gs.gkY=H/2; gs.gkTargetY=H/2;
        gs.teamPlayers=[
            {x:W*0.08,y:H*0.50,vx:0,vy:0,role:'gk',label:'P'},
            {x:W*0.24,y:H*0.24,vx:0,vy:0,role:'def',label:'2'},
            {x:W*0.24,y:H*0.76,vx:0,vy:0,role:'def',label:'3'},
            {x:W*0.38,y:H*0.34,vx:0,vy:0,role:'mid',label:'4'},
            {x:W*0.40,y:H*0.66,vx:0,vy:0,role:'mid',label:'5'},
        ];
        gs.aiPlayers=[
            {x:W*0.92,y:H*0.50,vx:0,vy:0,role:'gk',label:'P'},
            {x:W*0.76,y:H*0.24,vx:0,vy:0,role:'def',label:'2'},
            {x:W*0.76,y:H*0.76,vx:0,vy:0,role:'def',label:'3'},
            {x:W*0.62,y:H*0.34,vx:0,vy:0,role:'mid',label:'4'},
            {x:W*0.62,y:H*0.66,vx:0,vy:0,role:'mid',label:'5'},
            {x:W*0.86,y:H*0.50,vx:0,vy:0,role:'fwd',label:'6'},
        ];
        gs.phase='playing';
        gs.matchTime=0;
        gs.matchEventSchedule=[
            {f:Math.floor(60*6),type:'yellow'},
            {f:Math.floor(60*11),type:'throwin'},
            {f:Math.floor(60*16),type:'corner'},
            {f:Math.floor(60*22),type:'save'},
            {f:Math.floor(60*27),type:'penalty'},
            {f:Math.floor(60*31),type:Math.random()<0.35?'red':'goalkick'}
        ];
        gs.shotCooldown=0;
        gs.goalEvents=[];
        gs.keys={};

        // ── INPUT: TECLADO ────────────────────────────────────────────────
        function onKey(e,down){
            const map={ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right',
                       KeyW:'up',KeyS:'down',KeyA:'left',KeyD:'right',
                       Space:'shoot',KeyJ:'shoot',KeyK:'shoot'};
            const k=map[e.code];if(k){gs.keys[k]=down;if(k==='shoot'&&down)dispararBola();}
            if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();
        }
        document.addEventListener('keydown',e=>onKey(e,true));
        document.addEventListener('keyup',e=>onKey(e,false));
        gs._removeKeyListeners=()=>{
            document.removeEventListener('keydown',e=>onKey(e,true));
            document.removeEventListener('keyup',e=>onKey(e,false));
        };

        // ── INPUT: DPAD TÁCTIL ────────────────────────────────────────────
        ['up','down','left','right'].forEach(dir=>{
            const btn=$id('dpad-'+dir);
            if(!btn)return;
            const press=(e)=>{e.preventDefault();gs.keys[dir]=true;btn.classList.add('pressed');};
            const release=(e)=>{e.preventDefault();gs.keys[dir]=false;btn.classList.remove('pressed');};
            btn.addEventListener('touchstart',press,{passive:false});
            btn.addEventListener('touchend',release,{passive:false});
            btn.addEventListener('mousedown',press);
            btn.addEventListener('mouseup',release);
        });
        const shootBtn=$id('shoot-btn');
        if(shootBtn){
            shootBtn.addEventListener('touchstart',(e)=>{e.preventDefault();dispararBola();},{passive:false});
            shootBtn.addEventListener('mousedown',()=>dispararBola());
        }

        // ── TOUCH SWIPE en CANVAS ─────────────────────────────────────────
        let touchStartX=0,touchStartY=0;
        canvas.addEventListener('touchstart',(e)=>{
            e.preventDefault();
            touchStartX=e.touches[0].clientX;
            touchStartY=e.touches[0].clientY;
        },{passive:false});
        canvas.addEventListener('touchend',(e)=>{
            e.preventDefault();
            dispararBola();
        },{passive:false});

        function dispararBola(){
            if(gs.shotCooldown>0)return;
            const nearBall=Math.hypot(gs.bx-gs.px,gs.by-gs.py)<W*0.18;
            if(!nearBall)return;
            // Disparar hacia donde guía el usuario; si no hay dirección, al arco rival
            let dx=(gs.keys.right?1:0)-(gs.keys.left?1:0);
            let dy=(gs.keys.down?1:0)-(gs.keys.up?1:0);
            let ang;
            if(dx||dy){ang=Math.atan2(dy,dx);}else{ang=Math.atan2(gs.ch/2-gs.by,gs.cw-gs.bx);}
            const spd=17+Math.random()*7;
            gs.bvx=Math.cos(ang)*spd;
            gs.bvy=Math.sin(ang)*spd;
            gs.shooting=true;
            gs.shotCooldown=26;
            gs.playerShots++;
            gs.playerShotsOnTarget++;
            $id('game-hint').textContent='🎯 ¡Disparo!';
            setTimeout(()=>{if($id('game-hint'))$id('game-hint').textContent='';},700);
        }

        // ── LOOP ──────────────────────────────────────────────────────────
        const GAME_FRAMES=Math.floor(60*35); // partido más rápido y dinámico
        let frame=0;
        const SPEED=6.2; // jugador controlado más veloz

        function updateGame(){
            const{cw,ch}=gs;

            // El usuario guía el balón con flechas/botones; el equipo acompaña como futbolmesa
            let inputX=0,inputY=0;
            if(gs.keys.left) inputX-=1;
            if(gs.keys.right) inputX+=1;
            if(gs.keys.up) inputY-=1;
            if(gs.keys.down) inputY+=1;
            const inputLen=Math.hypot(inputX,inputY)||1;
            if(inputX||inputY){
                inputX/=inputLen; inputY/=inputLen;
                gs.bvx+=inputX*0.86; gs.bvy+=inputY*0.86;
                const guideX=Math.max(18,Math.min(cw*0.70,gs.bx-inputX*22));
                const guideY=Math.max(22,Math.min(ch-18,gs.by-inputY*22));
                gs.px+=(guideX-gs.px)*0.22; gs.py+=(guideY-gs.py)*0.22;
            } else {
                gs.px+=(Math.max(18,Math.min(cw*0.62,gs.bx-26))-gs.px)*0.08;
                gs.py+=(Math.max(22,Math.min(ch-18,gs.by))-gs.py)*0.08;
            }

            // Movimiento de pelota
            gs.bx+=gs.bvx; gs.by+=gs.bvy;
            const maxBallSpeed=13;
            const ballSpeed=Math.hypot(gs.bvx,gs.bvy);
            if(ballSpeed>maxBallSpeed){gs.bvx=gs.bvx/ballSpeed*maxBallSpeed;gs.bvy=gs.bvy/ballSpeed*maxBallSpeed;}
            gs.bvx*=0.94; gs.bvy*=0.94;
            if(Math.abs(gs.bvx)<0.1)gs.bvx=0;
            if(Math.abs(gs.bvy)<0.1)gs.bvy=0;

            // Rebote laterales y arriba/abajo
            const topWall=30,botWall=ch-12;
            if(gs.by-8<topWall){gs.by=topWall+8;gs.bvy*=-0.7;}
            if(gs.by+8>botWall){gs.by=botWall-8;gs.bvy*=-0.7;}

            // Portero rival (derecha) sigue pelota
            const gkSpeed=4.1+Math.random()*2.2;
            if(gs.by<gs.gkY-5)gs.gkY-=gkSpeed;
            else if(gs.by>gs.gkY+5)gs.gkY+=gkSpeed;
            gs.gkY=Math.max(ch*0.25+10,Math.min(ch*0.75-10,gs.gkY));

            // Gol del jugador (pelota pasa del límite derecho en zona de arco)
            const arcTop=ch*0.3,arcBot=ch*0.7,arcLeft=cw-18;
            if(gs.bx+8>arcLeft && gs.by>arcTop && gs.by<arcBot){
                // ¿El portero la para?
                const gkRange=ch*0.09;
                const saved=Math.abs(gs.by-gs.gkY)<gkRange && Math.random()<0.45;
                if(!saved){
                    gs.playerGoals++;
                    gs.goalEvents.push({text:'⚽ ¡GOL!',x:cw/2,y:ch/2,timer:55,color:'#00ff88',big:true});
                    $id('game-hint').textContent='🟢 ¡GOLAZO!';
                    setTimeout(()=>{if($id('game-hint'))$id('game-hint').textContent='';},1200);
                    resetBall(gs,'opp_kick');
                } else {
                    gs.saves++;
                    gs.goalEvents.push({text:'🧤 ¡Parada!',x:cw/2,y:ch*0.35,timer:35,color:'#ffaa00',big:false});
                    gs.bvx=-gs.bvx*0.9; gs.bvy=(Math.random()-0.5)*8;
                    gs.bx=arcLeft-20;
                }
            }

            // Gol rival (pelota pasa por izquierda en zona de arco)
            const arcLTop=ch*0.28,arcLBot=ch*0.72,arcRight=18;
            if(gs.bx-8<arcRight && gs.by>arcLTop && gs.by<arcLBot && gs.bvx<-2){
                if(Math.random()<0.4){
                    gs.oppGoals++;
                    gs.goalEvents.push({text:'❌ Gol rival',x:cw/2,y:ch/2,timer:50,color:'#ff4444',big:true});
                    resetBall(gs,'player_kick');
                } else {
                    gs.saves++;
                    gs.goalEvents.push({text:'🧤 Parada defensiva',x:cw/2,y:ch*0.35,timer:30,color:'#55d7ff',big:false});
                    gs.bvx=Math.abs(gs.bvx)*0.8+3; gs.bvy=(Math.random()-0.5)*6;
                    gs.bx=arcRight+16;
                }
            }

            // Pelota fuera laterales → saque / córner / saque de meta
            if(gs.bx<-20){gs.goalKicks++;gs.goalEvents.push({text:'🥅 Saque de meta',x:cw*0.34,y:ch*0.28,timer:30,color:'#55d7ff',big:false});resetBall(gs,'player_kick');}
            if(gs.bx>cw+20){gs.corners++;gs.goalEvents.push({text:'🚩 Tiro de esquina',x:cw*0.66,y:ch*0.28,timer:34,color:'#ffd84d',big:false});resetBall(gs,'opp_kick');}

            // Eventos arbitrales y jugadas del gameplay
            gs.matchEventSchedule=gs.matchEventSchedule.filter(ev=>{
                if(ev.f!==frame)return true;
                const data={
                    yellow:['🟨 Tarjeta amarilla','#ffd84d'],red:['🟥 Tarjeta roja','#ff5a6f'],corner:['🚩 Tiro de esquina','#ffd84d'],
                    save:['🧤 Parada espectacular','#55d7ff'],throwin:['🙌 Saque de banda','#ffffff'],penalty:['⚠️ Penal','#ff9f1c'],goalkick:['🥅 Saque de meta','#55d7ff']
                }[ev.type];
                if(ev.type==='yellow')gs.yellowCards++; if(ev.type==='red')gs.redCards++; if(ev.type==='corner')gs.corners++;
                if(ev.type==='save')gs.saves++; if(ev.type==='throwin')gs.throwIns++; if(ev.type==='penalty')gs.penalties++; if(ev.type==='goalkick')gs.goalKicks++;
                gs.goalEvents.push({text:data[0],x:cw/2,y:ch*0.42,timer:42,color:data[1],big:false});
                if(ev.type==='penalty'){gs.bx=cw*0.78;gs.by=ch/2;gs.bvx=0;gs.bvy=0;$id('game-hint').textContent='⚠️ Penal: apunta y dispara';}
                return false;
            });

            // Compañeros del usuario: 6v6 visible, se mueven en bloque con la pelota para atacar y defender
            gs.teamPlayers.forEach((tm,i)=>{
                const ballZone=Math.max(0,Math.min(1,gs.bx/cw));
                const attacking=gs.bx>=cw*0.5 || gs.bvx>1.2;
                const defending=gs.bx<cw*0.42 || gs.bvx<-1.2;
                const anchors=[
                    {x:cw*0.08,y:gs.by},
                    {x:cw*(defending?0.18:attacking?0.34:0.25),y:ch*0.24 + (gs.by-ch/2)*0.16},
                    {x:cw*(defending?0.18:attacking?0.34:0.25),y:ch*0.76 + (gs.by-ch/2)*0.16},
                    {x:cw*(defending?0.32:attacking?0.50:0.42),y:gs.by-ch*0.18},
                    {x:cw*(defending?0.34:attacking?0.52:0.42),y:gs.by+ch*0.18}
                ];
                const a=anchors[i]||anchors[0];
                const pressBoost=defending?0.30:attacking?0.18:0.10;
                const tx=tm.role==='gk'?cw*0.08:(Math.min(cw*0.58, a.x+(gs.bx-cw/2)*pressBoost));
                const ty=Math.max(18,Math.min(ch-18,a.y));
                tm.x+=(tx-tm.x)*(defending?0.105:0.082); tm.y+=(ty-tm.y)*(defending?0.115:0.09);
                if(Math.hypot(gs.bx-tm.x,gs.by-tm.y)<13 && tm.role!=='gk'){
                    const targetX=attacking?cw:Math.min(cw*0.62,gs.bx+cw*(0.18+ballZone*0.12));
                    const targetY=attacking?ch/2:gs.by+(i%2===0?-ch*0.14:ch*0.14);
                    const ang=Math.atan2(targetY-gs.by,targetX-gs.bx)+(Math.random()-0.5)*0.35;
                    gs.bvx=Math.cos(ang)*(7.5+Math.random()*5.5);
                    gs.bvy=Math.sin(ang)*(7.5+Math.random()*5.5);
                }
            });

            // IA rival: 6 jugadores presionan y empujan al arco izquierdo
            gs.aiPlayers.forEach((ai,i)=>{
                const aiSpd=(ai.role==='gk'?1.8:2.0)+i*0.22;
                const chaseX=ai.role==='gk'?cw*0.92:gs.bx,chaseY=ai.role==='gk'?gs.gkY:gs.by;
                const dx=chaseX-ai.x,dy=chaseY-ai.y;
                const dist=Math.hypot(dx,dy);
                if(dist>8){ai.x+=dx/dist*aiSpd;ai.y+=dy/dist*aiSpd;}
                ai.x=Math.max(cw*0.5,Math.min(cw-12,ai.x));
                ai.y=Math.max(12,Math.min(ch-12,ai.y));
                // Si IA toca la pelota
                if(Math.hypot(gs.bx-ai.x,gs.by-ai.y)<14 && ai.role!=='gk'){
                    const ang=Math.atan2(ch/2-gs.by, 0-gs.bx)+(Math.random()-0.5)*0.5;
                    gs.bvx=Math.cos(ang)*(7+Math.random()*7);
                    gs.bvy=Math.sin(ang)*(7+Math.random()*7);
                }
            });

            // Empujón del jugador a la pelota
            const playerDist=Math.hypot(gs.bx-gs.px,gs.by-gs.py);
            if(playerDist<16){
                const ang=Math.atan2(gs.by-gs.py,gs.bx-gs.px);
                gs.bvx+=Math.cos(ang)*4.6;gs.bvy+=Math.sin(ang)*4.6;
            }

            // Cooldown de disparo
            if(gs.shotCooldown>0)gs.shotCooldown--;

            // Goles predeterminados del oponente (asegura partido real)
            if(gs.oppScoreAt&&gs.oppScoreAt.includes(frame)){
                gs.oppGoals++;
                gs.goalEvents.push({text:'❌ Gol rival',x:cw/2,y:ch/2,timer:50,color:'#ff4444',big:true});
                resetBall(gs,'player_kick');
            }
            if(gs.playerBaseScoreAt&&gs.playerBaseScoreAt.includes(frame)){
                // Solo si el jugador va perdiendo o empatando
                if(gs.playerGoals<=gs.oppGoals){
                    gs.playerGoals++;
                    gs.goalEvents.push({text:'⚽ ¡GOL!',x:cw/2,y:ch/2,timer:55,color:'#00ff88',big:true});
                    resetBall(gs,'opp_kick');
                }
            }

            // Actualizar timer visual
            const minutos=Math.floor((frame/GAME_FRAMES)*90);
            if($id('hud-time'))$id('hud-time').textContent=`${minutos}'`;
            if($id('hud-score'))$id('hud-score').textContent=`${gs.playerGoals} — ${gs.oppGoals}`;
            if($id('hud-shots'))$id('hud-shots').textContent=`🎯 ${gs.playerShots} · 🟨${gs.yellowCards} 🟥${gs.redCards} 🚩${gs.corners} 🧤${gs.saves}`;

            // Goal events fade
            gs.goalEvents=gs.goalEvents.filter(g=>(g.timer--)>0);
            gs.goalEvents.forEach(g=>{g.y-=0.7;});
        }

        function resetBall(gs,who){
            gs.bx=gs.cw/2;gs.by=gs.ch/2;gs.bvx=0;gs.bvy=0;gs.shooting=false;
            if(who==='player_kick'){gs.bvx=5+Math.random()*3;}
            else{gs.bvx=-(5+Math.random()*3);}
        }

        function drawFrame(){
            const{cw,ch}=gs;
            ctx.clearRect(0,0,cw,ch);

            // Cancha futbolmesa con acabado Pixar
            const grad=ctx.createLinearGradient(0,0,cw,0);
            grad.addColorStop(0,'#22792a');grad.addColorStop(0.5,'#36ad3a');grad.addColorStop(1,'#197043');
            ctx.fillStyle=grad;ctx.fillRect(0,0,cw,ch);
            ctx.fillStyle='rgba(255,255,255,0.06)';
            for(let sx=0;sx<cw;sx+=42){ctx.fillRect(sx,25,20,ch-35);}
            ctx.fillStyle='rgba(255,216,77,0.18)';ctx.font='18px sans-serif';ctx.textAlign='center';
            ['🇧🇷','🇦🇷','🇪🇸','🇨🇴','🇫🇷','🇵🇹'].forEach((f,i)=>ctx.fillText(f,44+i*(cw-88)/5,20));

            // Líneas del campo
            ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=2;
            ctx.strokeRect(10,25,cw-20,ch-35);
            ctx.beginPath();ctx.moveTo(cw/2,25);ctx.lineTo(cw/2,ch-10);ctx.stroke();
            ctx.beginPath();ctx.arc(cw/2,ch/2,Math.min(50,ch*0.15),0,Math.PI*2);ctx.stroke();

            // Arco izquierdo (jugador defiende)
            const arcH=ch*0.44;
            ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=3;
            ctx.strokeRect(10,ch/2-arcH/2,22,arcH);
            // Arco derecho (rival defiende)
            ctx.strokeRect(cw-32,ch/2-arcH/2,22,arcH);

            // Red arcos
            ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=1;
            for(let ry=ch/2-arcH/2;ry<ch/2+arcH/2;ry+=8){
                ctx.beginPath();ctx.moveTo(10,ry);ctx.lineTo(32,ry);ctx.stroke();
                ctx.beginPath();ctx.moveTo(cw-32,ry);ctx.lineTo(cw-10,ry);ctx.stroke();
            }

            // Barras tipo futbolmesa
            const rodYs=[gs.py,...gs.teamPlayers.map(p=>p.y),...gs.aiPlayers.map(p=>p.y)];
            ctx.strokeStyle='rgba(230,245,255,0.38)';ctx.lineWidth=4;
            rodYs.forEach(y=>{ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(cw,y);ctx.stroke();});
            ctx.strokeStyle='rgba(0,0,0,0.28)';ctx.lineWidth=1;
            rodYs.forEach(y=>{ctx.beginPath();ctx.moveTo(0,y+3);ctx.lineTo(cw,y+3);ctx.stroke();});

            // Equipo del usuario: 6 jugadores (controlado + 5 compañeros)
            const pc1=gs.player.color1||'#1a6aff';
            const pc2=gs.player.color2||'#fff';
            gs.teamPlayers.forEach(tm=>drawFoosballPlayer(ctx,tm.x,tm.y,'#36c7ff','#ffffff',tm.label,false));
            drawFoosballPlayer(ctx,gs.px,gs.py,pc1,pc2,'★',true);

            // Equipo rival: 6 jugadores
            gs.aiPlayers.forEach((ai)=>{
                drawFoosballPlayer(ctx,ai.x,ai.y,ai.role==='gk'?'#ff9f1c':'#ff4b5f','#fff',ai.label,false);
            });

            // Pelota
            ctx.save();
            ctx.fillStyle='#fff';
            ctx.shadowColor='rgba(255,255,255,0.5)';
            ctx.shadowBlur=8;
            ctx.beginPath();ctx.arc(gs.bx,gs.by,8,0,Math.PI*2);ctx.fill();
            ctx.strokeStyle='#333';ctx.lineWidth=1.5;ctx.stroke();
            // Sombra pelota
            ctx.fillStyle='rgba(0,0,0,0.2)';ctx.beginPath();ctx.ellipse(gs.bx,gs.by+10,7,3,0,0,Math.PI*2);ctx.fill();
            ctx.restore();

            // Indicador de rango de disparo
            if(gs.shotCooldown<=0){
                const dist=Math.hypot(gs.bx-gs.px,gs.by-gs.py);
                if(dist<cw*0.18){
                    ctx.strokeStyle='rgba(0,255,136,0.4)';ctx.lineWidth=1.5;ctx.setLineDash([4,4]);
                    ctx.beginPath();ctx.arc(gs.px,gs.py,cw*0.18,0,Math.PI*2);ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // Marcador de eventos: tarjetas, córners, saques, penales y paradas
            ctx.fillStyle='rgba(0,0,0,0.64)';roundRect2(ctx,cw-190,4,184,24,7);ctx.fill();
            ctx.fillStyle='#fff';ctx.font='bold 10px Fredoka,sans-serif';ctx.textAlign='center';
            ctx.fillText(`🟨${gs.yellowCards} 🟥${gs.redCards} 🚩${gs.corners} 🧤${gs.saves} 🙌${gs.throwIns} ⚠️${gs.penalties}`,cw-98,20);

            // Goal events text
            gs.goalEvents.forEach(g=>{
                const alpha=Math.min(1,g.timer/20);
                ctx.save();ctx.globalAlpha=alpha;
                ctx.font=`bold ${g.big?28:18}px Orbitron,sans-serif`;
                ctx.fillStyle=g.color;ctx.textAlign='center';
                ctx.shadowColor=g.color;ctx.shadowBlur=15;
                ctx.fillText(g.text,g.x,g.y);
                ctx.restore();
            });

            // Reloj esquina
            const prog=Math.min(1,frame/GAME_FRAMES);
            const minF=Math.floor(prog*90);
            ctx.fillStyle='rgba(0,0,0,0.75)';
            roundRect2(ctx,4,4,52,24,7);ctx.fill();
            ctx.fillStyle='#00ff88';ctx.font='bold 12px Orbitron,monospace';ctx.textAlign='center';
            ctx.fillText(`${minF}'`,30,20);

            // Barra de tiempo
            ctx.fillStyle='rgba(255,255,255,0.08)';ctx.fillRect(10,ch-8,cw-20,4);
            ctx.fillStyle='rgba(0,255,136,0.6)';ctx.fillRect(10,ch-8,Math.floor((cw-20)*prog),4);
        }

        function drawPlayerSprite(ctx,x,y,c1,c2,label){
            // Estilo Pixar: silueta redondeada, ojos grandes y volumen suave
            ctx.fillStyle='rgba(0,0,0,0.24)';ctx.beginPath();ctx.ellipse(x,y+16,13,5,0,0,Math.PI*2);ctx.fill();
            const bodyGrad=ctx.createLinearGradient(x-10,y-8,x+10,y+20);
            bodyGrad.addColorStop(0,'#ffffff');bodyGrad.addColorStop(0.18,c1);bodyGrad.addColorStop(1,'#123');
            ctx.fillStyle=bodyGrad;ctx.beginPath();ctx.ellipse(x,y+6,11,15,0,0,Math.PI*2);ctx.fill();
            ctx.fillStyle='#ffd1b6';ctx.beginPath();ctx.arc(x,y-10,9,0,Math.PI*2);ctx.fill();
            ctx.fillStyle='rgba(255,255,255,0.9)';ctx.beginPath();ctx.arc(x-3,y-12,2.3,0,Math.PI*2);ctx.arc(x+3,y-12,2.3,0,Math.PI*2);ctx.fill();
            ctx.fillStyle='#1b2430';ctx.beginPath();ctx.arc(x-3,y-12,1,0,Math.PI*2);ctx.arc(x+3,y-12,1,0,Math.PI*2);ctx.fill();
            ctx.strokeStyle='rgba(255,255,255,0.55)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y+6,11,Math.PI*1.18,Math.PI*1.82);ctx.stroke();
            ctx.fillStyle=c2;ctx.font='bold 8px Fredoka,sans-serif';ctx.textAlign='center';
            ctx.fillText(String(label),x,y+9);
        }

        function drawFoosballPlayer(ctx,x,y,c1,c2,label,isUser){
            ctx.save();
            ctx.fillStyle='rgba(0,0,0,0.24)';ctx.beginPath();ctx.ellipse(x,y+22,16,5,0,0,Math.PI*2);ctx.fill();
            const bodyGrad=ctx.createLinearGradient(x-13,y-18,x+13,y+20);
            bodyGrad.addColorStop(0,'#ffffff');bodyGrad.addColorStop(0.22,c1);bodyGrad.addColorStop(1,'#0b3417');
            ctx.fillStyle=bodyGrad;roundRect2(ctx,x-12,y-15,24,32,8);ctx.fill();
            ctx.fillStyle=c2;ctx.fillRect(x-12,y-2,24,4);
            ctx.fillStyle='#ffd4b8';ctx.beginPath();ctx.arc(x,y-22,10,0,Math.PI*2);ctx.fill();
            ctx.fillStyle='#2d160b';ctx.beginPath();ctx.arc(x,y-27,9,Math.PI,Math.PI*2);ctx.fill();
            ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x-4,y-24,2.6,0,Math.PI*2);ctx.arc(x+4,y-24,2.6,0,Math.PI*2);ctx.fill();
            ctx.fillStyle='#1b2430';ctx.beginPath();ctx.arc(x-4,y-24,1.1,0,Math.PI*2);ctx.arc(x+4,y-24,1.1,0,Math.PI*2);ctx.fill();
            ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-13,y-7);ctx.lineTo(x-23,y+2);ctx.moveTo(x+13,y-7);ctx.lineTo(x+23,y+2);ctx.stroke();
            ctx.strokeStyle='#102410';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(x-6,y+16);ctx.lineTo(x-10,y+28);ctx.moveTo(x+6,y+16);ctx.lineTo(x+10,y+28);ctx.stroke();
            ctx.fillStyle='rgba(255,255,255,0.95)';ctx.font='bold 9px Fredoka,sans-serif';ctx.textAlign='center';ctx.fillText(String(label),x,y+8);
            if(isUser){ctx.strokeStyle='rgba(255,216,77,0.95)';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y-2,20+Math.sin(frame/8)*2,0,Math.PI*2);ctx.stroke();}
            ctx.restore();
        }

        function roundRect2(ctx,x,y,w,h,r){
            ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);
            ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);
            ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);
            ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);
            ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
        }

        // ── GAME LOOP ─────────────────────────────────────────────────────
        const FPS_TARGET=1000/60;
        let lastTs=0;
        function loop(ts){
            if(gs.phase!=='playing'){return;}
            if(ts-lastTs>=FPS_TARGET-2){
                updateGame();
                drawFrame();
                lastTs=ts;
                frame++;
                if(frame>=GAME_FRAMES){
                    gs.phase='result';
                    // Resolver resultado con los goles REALES del juego interactivo
                    const pgFinal=gs.playerGoals;
                    const ogFinal=gs.oppGoals;
                    const res=pgFinal>ogFinal?'win':pgFinal===ogFinal?'draw':'loss';
                    _matchResultPending={
                        idx:gs.idx,copy:gs.copy,player:gs.player,
                        playerGoals:pgFinal,oppGoals:ogFinal,resultado:res,
                        oppName:gs.opp.nombre,oppFlag:gs.opp.flag
                    };
                    setTimeout(()=>mostrarResultadoVideo(),400);
                    return;
                }
            }
            _matchAnimFrame=requestAnimationFrame(loop);
        }
        if(_matchAnimFrame)cancelAnimationFrame(_matchAnimFrame);
        _matchAnimFrame=requestAnimationFrame(loop);
    }

    function mostrarResultadoVideo(){
        const{idx,copy,player,playerGoals,oppGoals,resultado}=_matchResultPending;
        // oppName/oppFlag vienen del gameState o del pending
        const oppName=_matchResultPending.oppName||(_currentMatchMode==='pve'?`IA · ${_currentMatchCancha}`:'Rival');
        const oppFlag=_matchResultPending.oppFlag||'🤖';
        statsPartidas+=2;
        totalGoals+=playerGoals;

        // Incrementar habilidades aleatoriamente por partido
        const skillsToInc = SKILLS.filter(()=>Math.random()<0.5);
        skillsToInc.forEach(sk => {
            if(!skillCounts[sk.id]) skillCounts[sk.id]=0;
            skillCounts[sk.id] += Math.floor(Math.random()*3)+1;
        });

        puntaje+=(resultado==='win'?(5+nivel*2):resultado==='draw'?(2+nivel):1);
        const gemMin=player.gemMin, gemMax=player.gemMax;
        const bonus=gemasBonus();
        const eq=getSlotEquip(idx,copy);
        let pctMin=0.10, pctMax=0.20;
        let equippedCount=0;
        if(eq.uniforme)equippedCount++;
        if(eq.tenis)equippedCount++;
        if(eq.protector)equippedCount++;
        pctMax=Math.min(0.45, 0.20 + equippedCount*0.07);
        pctMin=Math.min(pctMax-0.05, 0.10 + equippedCount*0.04);
        const trainBonus=equippedCount===3 ? 1.05 : 1.0;
        const pct=pctMin+Math.random()*(pctMax-pctMin);
        let gemsGanadas=0;
        if(resultado==='win'){
            const baseW=gemMin+Math.random()*(gemMax-gemMin);
            gemsGanadas=parseFloat((baseW*pct*trainBonus + bonus).toFixed(1));
        }else if(resultado==='draw'){
            const baseD=(gemMin+Math.random()*(gemMax-gemMin))*0.4;
            gemsGanadas=parseFloat((baseD*pct*trainBonus + bonus).toFixed(1));
        }
        if(gemsGanadas>0)gemas+=gemsGanadas;
        actualizarUI();

        const resultColor=resultado==='win'?'#00ff88':resultado==='draw'?'#ffd700':'#ff4444';
        const resultText=resultado==='win'?'🏆 ¡VICTORIA!':resultado==='draw'?'🤝 EMPATE':'❌ DERROTA';
        const dur=getDurabilidad(idx,copy);const nftId=generatePlayerId(idx,copy);

        const shotsInfo=_gameState?`<div style="font-size:0.74em;color:var(--cyan);margin-top:2px">🎯 Disparos: ${_gameState.playerShots} · Al arco: ${_gameState.playerShotsOnTarget}</div><div style="font-size:0.74em;color:var(--gold);margin-top:2px">🟨 Amarillas: ${_gameState.yellowCards} · 🟥 Rojas: ${_gameState.redCards} · 🚩 Córners: ${_gameState.corners} · 🧤 Paradas: ${_gameState.saves} · 🙌 Saques: ${_gameState.throwIns} · ⚠️ Penales: ${_gameState.penalties}</div>`:'';

        const gemsMsg=resultado==='win'
            ?`<span style="color:var(--green);font-weight:700">+${gemsGanadas} 💎 ganadas</span>`
            :resultado==='draw'
            ?`<span style="color:var(--gold);font-weight:700">+${gemsGanadas} 💎 ganadas</span>`
            :`<span style="color:var(--red);font-weight:700">0 💎 (derrota)</span>`;

        const rangeNote=`<div style="font-size:0.74em;color:#888;margin-top:2px">Rango NFT: ${gemMin.toLocaleString()}–${gemMax.toLocaleString()} 💎/día</div>`;
        const bonusNote=bonus>0?`<div style="font-size:0.74em;color:var(--cyan)">Bonus Nivel ${nivel}: +${bonus.toFixed(1)} 💎</div>`:'';
        const goalNote=`<div style="font-size:0.74em;color:var(--gold)">⚽ Goles acumulados: ${totalGoals} (ciclo ${getGoalCycleInfo().cycle})</div>`;
        const skillNote=skillsToInc.length>0?`<div style="font-size:0.74em;color:var(--cyan);margin-top:2px">🏅 +Stats en: ${skillsToInc.slice(0,3).map(s=>s.nombre).join(', ')}${skillsToInc.length>3?'...':''}</div>`:'';

        const rb=$id('video-result-box');
        rb.innerHTML=`<div style="background:linear-gradient(135deg,#0a1a0a,#060d06);border:2px solid ${resultColor};border-radius:16px;padding:18px;text-align:center">
<div style="font-family:'Bebas Neue',sans-serif;font-size:2em;color:${resultColor};letter-spacing:4px">${resultText}</div>
<div style="font-family:'Bebas Neue',sans-serif;font-size:3.5em;color:var(--gold);line-height:1.1;margin:8px 0">${playerGoals} — ${oppGoals}</div>
<div style="font-size:0.88em;color:#aaa;margin-bottom:6px">${player.flag} ${player.nombre} vs ${oppFlag} ${oppName}</div>
<div style="font-size:0.78em;color:var(--cyan);font-family:'Orbitron',sans-serif;margin-bottom:8px">NFT ID: ${nftId}</div>
<div style="font-size:1em;margin:8px 0">${gemsMsg}</div>
${shotsInfo}${rangeNote}${bonusNote}${goalNote}${skillNote}
<div style="font-size:0.8em;color:#888">+2 pts estadística · Forma física: ${dur}%</div>
</div>`;
        // Mostrar pantalla de resultado
        if(_matchAnimFrame)cancelAnimationFrame(_matchAnimFrame);
        showScreen('match-result-screen');
        $id('match-result-screen').style.display='flex';
        if(_gameState)_gameState.phase='result';
        saveState();
    }
    function cerrarVideoPartida(){
        $id('video-overlay').classList.remove('active');
        document.body.style.overflow='';
        if(_matchAnimFrame)cancelAnimationFrame(_matchAnimFrame);
        _matchAnimFrame=null;
        if(_gameState&&_gameState._removeKeyListeners)_gameState._removeKeyListeners();
        if(_gameState)_gameState.phase='done';
        _gameState=null;
        _currentMatchPlayer=null;
        _matchResultPending=null;
        // Reset screens
        ['match-intro-screen','match-game-screen','match-result-screen'].forEach(id=>{
            const el=$id(id);if(el)el.style.display='none';
        });
    }

    // ── FUTSALA ───────────────────────────────────────────────────────────
    function buildFutsalaBody(){
        $id('futsala-body').innerHTML=`
<div class="futsala-info-box">✅ Modo GRATUITO — Sin gemas &nbsp;·&nbsp; Gemas según tu NFT + pts estadísticas</div>
<div style="background:rgba(0,255,136,0.06);border:1px solid rgba(0,255,136,0.2);border-radius:12px;padding:14px;margin-bottom:14px;">
<div style="font-family:'Orbitron',sans-serif;font-size:0.72em;color:var(--green);letter-spacing:2px;margin-bottom:10px;">💎 GANANCIAS — SEGÚN NFT SELECCIONADO</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;">
    <div style="background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.3);border-radius:8px;padding:10px;"><div style="font-size:1.3em">🏆</div><div style="color:var(--green);font-weight:700;font-size:0.9em">Victoria</div><div style="color:#aaa;font-size:0.78em;margin-top:3px">rango del NFT</div></div>
    <div style="background:rgba(255,215,0,0.06);border:1px solid rgba(255,215,0,0.2);border-radius:8px;padding:10px;"><div style="font-size:1.3em">🤝</div><div style="color:var(--gold);font-weight:700;font-size:0.9em">Empate</div><div style="color:#aaa;font-size:0.78em;margin-top:3px">40% del rango</div></div>
    <div style="background:rgba(255,68,68,0.06);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:10px;"><div style="font-size:1.3em">❌</div><div style="color:var(--red);font-weight:700;font-size:0.9em">Derrota</div><div style="color:#aaa;font-size:0.78em;margin-top:3px">0 💎</div></div>
</div></div>
<div class="info-box" style="margin-bottom:12px;">⚠️ Cada partida consume 1 balón · Forma física −0.8%</div>
<p style="color:#888;font-size:0.84em;margin-bottom:12px;">Elige una cancha y compite:</p>
<div class="map-grid">
    <div class="map-card" onclick="abrirSeleccionJugadorFutsala('Cancha Barrial')"><div class="map-card-img" style="background:linear-gradient(135deg,#0a1a0a,#1a3a1a)">🏟️</div><div class="map-card-info"><h4>Cancha Barrial</h4><p>Partidos rápidos.</p><span class="map-tag">⭐ Fácil · +2 pts</span></div></div>
    <div class="map-card" onclick="abrirSeleccionJugadorFutsala('Estadio Municipal')"><div class="map-card-img" style="background:linear-gradient(135deg,#1a1a0a,#3a2a0a)">🏟️</div><div class="map-card-info"><h4>Estadio Municipal</h4><p>Mayor presión táctica.</p><span class="map-tag">⭐⭐ Medio · +2 pts</span></div></div>
    <div class="map-card" onclick="abrirSeleccionJugadorFutsala('Copa del Mundo')"><div class="map-card-img" style="background:linear-gradient(135deg,#1a0a0a,#3a0a0a)">🏆</div><div class="map-card-info"><h4>Copa del Mundo</h4><p>Alta dificultad.</p><span class="map-tag">⭐⭐⭐ Difícil · +2 pts</span></div></div>
    <div class="map-card" onclick="abrirSeleccionJugadorFutsala('Noche de Gala')"><div class="map-card-img" style="background:linear-gradient(135deg,#0a0a1a,#0a1a3a)">🌃</div><div class="map-card-info"><h4>Noche de Gala</h4><p>El reto máximo.</p><span class="map-tag">⭐⭐⭐⭐ Experto · +2 pts</span></div></div>
</div>`;
    }

    // ── RECOMPENSAS POR GOLES ─────────────────────────────────────────────
    function buildRewardPts(){
        actualizarUI();
        const milestones=getGoalMilestones();
        const info=getGoalCycleInfo();
        let html='';
        milestones.forEach(m=>{
            const pct=Math.min(100,Math.round((info.goalsInCycle/m.goalsNeeded)*100));
            const canClaim=m.achieved&&!m.claimed;
            html+=`<div class="reward-section" style="${m.claimed?'opacity:0.5':''}${m.achieved&&!m.claimed?';border-color:rgba(0,255,136,0.4)':''}">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div>
        <span style="font-size:1em;">⚽</span>
        <strong style="font-size:0.9em;margin-left:6px;color:${m.achieved?'var(--green)':'#aaa'}">${m.goalsNeeded} goles</strong>
        <span style="font-size:0.72em;color:#555;margin-left:8px">en ciclo ${info.cycle}</span>
    </div>
    <div style="font-weight:700;color:var(--gold);font-family:'Orbitron',sans-serif;font-size:0.85em">+${m.gems} 💎</div>
</div>
<div class="pts-bar-bg"><div class="pts-bar-fill" style="width:${pct}%"></div></div>
<div style="display:flex;justify-content:space-between;font-size:0.72em;color:#555;margin-top:4px">
    <span>Progreso: ${Math.min(info.goalsInCycle,m.goalsNeeded)} / ${m.goalsNeeded}</span>
    <span style="color:${m.achieved?'var(--green)':'#555'}">${m.achieved?'✅ Logrado':'⏳ Pendiente'}</span>
</div>
${!m.claimed?`<button style="width:100%;margin-top:8px;padding:8px;background:${canClaim?'rgba(0,255,136,0.1)':'rgba(255,255,255,0.03)'};border:1px solid ${canClaim?'var(--green)':'rgba(255,255,255,0.07)'};border-radius:8px;color:${canClaim?'var(--green)':'#555'};font-family:'Rajdhani',sans-serif;font-weight:700;font-size:0.84em;cursor:${canClaim?'pointer':'not-allowed'};text-transform:uppercase;transition:all 0.25s" onclick="${canClaim?`claimGoalMilestone('${m.key}',${m.gems})`:'void(0)'}">
${canClaim?`✅ Reclamar +${m.gems} 💎`:'⏳ Necesitas más goles'}</button>`
:`<div style="text-align:center;margin-top:8px;font-size:0.78em;color:#555">✅ Ya reclamado</div>`}
</div>`;
        });
        $id('goals-rewards-list').innerHTML=html;
    }

    // ── RECOMPENSA DIARIA ─────────────────────────────────────────────────
    function getDailyRewardGems(dia){if(dia===30)return 25;if(dia%2===1)return 1;return 0;}
    function getDailyRewardXP(dia){return (dia%2===0&&dia!==30)?25:1;}
    function getUtcDayKey(){const n=new Date();return `${n.getUTCFullYear()}-${String(n.getUTCMonth()+1).padStart(2,'0')}-${String(n.getUTCDate()).padStart(2,'0')}`;}
    function getDailyCycleDay(){const start=Date.UTC(2025,0,1),now=new Date();const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());return (Math.floor((today-start)/86400000)%30)+1;}
    function buildRewardDays(){const diaActual=getDailyCycleDay();const claimedToday=localStorage.getItem('tg_last_reward_day_key')===getUtcDayKey();let html='';for(let d=1;d<=30;d++){const isToday=d===diaActual,isXP=d%2===0&&d!==30,isDay30=d===30;let cls='reward-day';if(isDay30)cls+=' special';else if(isXP)cls+=' gold-day';if(isToday&&claimedToday)cls+=' claimed';if(isToday)cls+=' today';const icon=isDay30?'👑':isXP?'📘':'💎';const label=isDay30?'25💎':isXP?`+${getDailyRewardXP(d)} XP`:`${getDailyRewardGems(d)}💎`;const check=(isToday&&claimedToday)?'<div style="position:absolute;top:2px;right:4px;color:var(--green);font-weight:700;font-size:0.8em">✓</div>':'';html+=`<div class="${cls}" style="position:relative">${check}<span class="day-icon">${icon}</span><div style="font-weight:700">${d}</div><small>${label}</small></div>`;}$id('reward-days-grid').innerHTML=html;}
    function checkRewardStatus(){buildRewardDays();const canClaim=localStorage.getItem('tg_last_reward_day_key')!==getUtcDayKey();const btn=$id('btn-claim-reward');if(btn){btn.disabled=!canClaim;btn.textContent=canClaim?'✅ Reclamar recompensa de hoy':'✓ Recompensa de hoy reclamada';}updateDailyTimer(0,canClaim);}
    function updateDailyTimer(msR,canClaim){const el=$id('daily-timer-display');if(!el)return;if(canClaim){el.textContent='✅ Reclama solo la recompensa del día actual; si no la reclamas, se pierde.';el.style.color='var(--green)';return;}const n=new Date();const next=Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()+1);const left=Math.max(0,next-n.getTime());const h=Math.floor(left/3600000),m=Math.floor((left%3600000)/60000),s=Math.floor((left%60000)/1000);el.textContent=`⏱ Próxima recompensa en ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;el.style.color='#666';}
    setInterval(()=>{const modal=$id('modal-recompensa');if(modal&&modal.classList.contains('active'))checkRewardStatus();},1000);
    function claimReward(){const dayKey=getUtcDayKey();if(localStorage.getItem('tg_last_reward_day_key')===dayKey){mostrarMensaje('⚠️ Ya reclamaste la recompensa de hoy','#ffaa00');return;}const diaActual=getDailyCycleDay(),gemsGanadas=getDailyRewardGems(diaActual),xpGanado=getDailyRewardXP(diaActual),isDay30=diaActual===30,isXP=diaActual%2===0&&!isDay30;gemas+=gemsGanadas;puntaje+=xpGanado;let msg=isDay30?`👑 ¡Día 30! +${gemsGanadas} 💎 +${xpGanado} XP`:isXP?`📘 +${xpGanado} puntos de experiencia`:`💎 +${gemsGanadas} gema +${xpGanado} XP`;localStorage.setItem('tg_last_reward_day_key',dayKey);localStorage.setItem('tg_last_reward_ts',String(Date.now()));localStorage.setItem('tg_reward_day',String(diaActual));if(typeof saveState==='function')saveState();actualizarUI();buildRewardDays();const btn=$id('btn-claim-reward');if(btn){btn.disabled=true;btn.textContent='✓ Recompensa de hoy reclamada';}mostrarMensaje(msg,isDay30?'#a855f7':isXP?'#55d7ff':'#00ff88');}

    // ── ENTRENAMIENTO ─────────────────────────────────────────────────────
    // Bonus de rendimiento progresivo por sesión:
    // Sesión 1=+5%, 2=+10%, 3=+15%, 4=+17%, 5=+19%, luego +2% por sesión hasta llegar a 80% → se reinicia a 0
    let trainingData = JSON.parse(localStorage.getItem('tg_training_data')||'{}'); // { slotKey: { sesiones: n, bonus: % } }
    function saveTraining(){ localStorage.setItem('tg_training_data', JSON.stringify(trainingData)); }
    function getTrainingInfo(idx,copy=0){
        const k=slotKey(idx,copy);
        if(!trainingData[k]) trainingData[k]={sesiones:0,bonus:0};
        return trainingData[k];
    }
    function nextTrainingBonus(currentSesiones,currentBonus){
        const nextSesion = currentSesiones + 1;
        if(nextSesion===1) return 5;
        if(nextSesion===2) return 10;
        if(nextSesion===3) return 15;
        if(nextSesion===4) return 17;
        if(nextSesion===5) return 19;
        return 2;
    }
    function applyTrainingBonus(idx,copy=0){
        const info = getTrainingInfo(idx,copy);
        const incremento = nextTrainingBonus(info.sesiones, info.bonus);
        let nuevoBonus = info.bonus + incremento;
        let reinicio = false;
        if(nuevoBonus >= 80){ nuevoBonus = 0; info.sesiones = 0; reinicio = true; }
        else { info.sesiones += 1; }
        info.bonus = nuevoBonus;
        saveTraining();
        return { incremento, nuevoBonus, reinicio };
    }
    function buildMantenimiento(){
        const lista=$id('mant-list');
        if(!carrosComprados.length){lista.innerHTML=`<div class="coming-soon-box">No tienes futbolistas. ¡Ficha uno en el Marketplace!</div>`;return;}
        let html='';
        carrosComprados.forEach(entry=>{
            for(let copy=0;copy<entry.qty;copy++){
                const c=PLAYERS[entry.idx];const dur=getDurabilidad(entry.idx,copy);const dc=colorDurabilidad(dur);
                const t=getTrainingInfo(entry.idx,copy);
                const proximoInc = nextTrainingBonus(t.sesiones, t.bonus);
                const ovrBoosted = Math.round(c.hp * (1 + t.bonus/100));
                html+=`<div class="mant-item">
<img src="${playerImgSrc(entry.idx)}" alt="${c.nombre}" style="width:60px;height:80px;object-fit:cover;border-radius:8px;border:1px solid rgba(45,122,31,0.3)" onerror="this.style.display='none'">
<div class="mant-info"><h4>${c.nombre}${entry.qty>1?' #'+(copy+1):''}</h4><p>⚡ OVR ${c.hp} ${t.bonus>0?`<span style="color:var(--green)">→ ${ovrBoosted} (+${t.bonus}%)</span>`:''} · ${c.pos} · 📈 ${c.gemMin.toLocaleString()}–${c.gemMax.toLocaleString()} 💎/día</p>
<div class="dur-bar-wrap" style="margin-top:6px"><div class="dur-bar-label"><span>💪 Durabilidad</span><span style="color:${dur>=60?'var(--green)':dur>=30?'var(--gold)':'var(--red)'}">${dur}%</span></div><div class="dur-bar-bg"><div class="dur-bar-fill ${dc}" style="width:${dur}%"></div></div></div>
<div style="margin-top:6px;font-size:0.74em;color:#888">🏋️ Sesiones: <strong style="color:var(--cyan)">${t.sesiones}</strong> · Próximo bonus: <strong style="color:var(--green)">+${proximoInc}%</strong></div></div>
<div class="mant-price"><strong>$${getCostoMantenimiento(c.precio).toFixed(2)} USDT</strong><small>Entrenamiento</small><button class="mant-btn" onclick="pagarMantenimiento(${entry.idx},${copy})">🏋️ Entrenar</button></div>
</div>`;
            }
        });
        lista.innerHTML=html;
    }
    async function pagarMantenimiento(idx,copy=0){
        const c=PLAYERS[idx];
        const costo=getCostoMantenimiento(c.precio);
        // Abrir modal QR con la dirección del contrato inteligente
        abrirPagoQR({
            tipo:'entrenamiento',
            titulo:`🏋️ Entrenamiento — ${c.nombre}`,
            descripcion:`Restaura durabilidad al 100% y aplica bonus de rendimiento progresivo.`,
            usdt:costo,
            onConfirmar:async()=>{
                if(!isWalletConnected()){mostrarMensaje('⚠️ Conecta tu wallet primero','#ffaa00');openWalletModal();return false;}
                mostrarMensaje(`⏳ Procesando $${costo.toFixed(2)} USDT...`,'#00d4ff');
                try{
                    const tx=await buildContractTx('entrenamiento',costo);
                    await tonConnectUI.sendTransaction(tx);
                    repararDurabilidad(idx,copy);
                    const res=applyTrainingBonus(idx,copy);
                    actualizarUI();
                    buildMantenimiento();
                    const msg=res.reinicio
                        ? `✅ Durabilidad 100% · Bonus alcanzó 80% y se reinició a 0%`
                        : `✅ Durabilidad 100% · Rendimiento +${res.incremento}% (total +${res.nuevoBonus}%)`;
                    mostrarMensaje(msg,'#00ff88');
                    return true;
                }catch(e){mostrarMensaje('❌ Transacción cancelada','#ff4444');return false;}
            }
        });
    }

    let _captchaAnswer=0;
    function generarCaptcha(){const a=Math.floor(Math.random()*9)+1,b=Math.floor(Math.random()*9)+1;_captchaAnswer=a+b;const q=$id('captcha-question');if(q)q.textContent=`${a} + ${b} = ?`;const ans=$id('captcha-answer');if(ans)ans.value='';}
    function actualizarConversionRetiro(){const cant=parseFloat($id('retiro-cantidad').value)||0;const bruto=cant/32;const descuento=bruto*0.06;const fijo=1;const neto=Math.max(0,(bruto-descuento-fijo)).toFixed(2);const d=$id('retiro-usdt-display');if(d)d.textContent=`${neto} USDT`;const input=$id('retiro-cantidad'),warn=$id('retiro-warning');const invalid=cant>gemas;if(input)input.classList.toggle('invalid',invalid);if(warn)warn.classList.toggle('show',invalid);}
    function actualizarSaldoRetiro(){const a=$id('retiro-saldo-display'),b=$id('retiro-saldo-inline');if(a)a.textContent=gemas.toFixed(1)+' 💎';if(b)b.textContent=gemas.toFixed(1);actualizarConversionRetiro();}

    function retirar(){
        const cant=parseFloat($id('retiro-cantidad').value)||0;
        const addr=($id('retiro-address').value||'').trim();
        if(!addr){mostrarMensaje(t('msg_addr_req'),'#ffaa00');return;}
        if(cant<160){mostrarMensaje(t('msg_min'),'#ff4444');return;}
        if(cant>3000){mostrarMensaje('❌ Máximo 3000 💎 por día','#ff4444');return;}
        if(cant>gemas){actualizarConversionRetiro();mostrarMensaje('🚫 No puedes hacer ese retiro: monto mayor a tu saldo disponible','#ff4444');return;}
        const userAns=parseInt($id('captcha-answer').value);
        if(isNaN(userAns)||userAns!==_captchaAnswer){mostrarMensaje(t('msg_captcha'),'#ff4444');generarCaptcha();return;}
        const bruto=cant/32;const descuento=bruto*0.06;const fijo=1;const usdt=Math.max(0,(bruto-descuento-fijo)).toFixed(2);
        const feesToContract=(descuento+fijo).toFixed(2);
        const withdrawalOrder=getWithdrawalOrder(cant,usdt,addr,feesToContract);
        if(withdrawalOrder.contrato!==getContractWallet()){mostrarMensaje('❌ Orden de retiro con contrato inválido','#ff4444');return;}
        const refOwnerPfx = localStorage.getItem(_pfx()+'_my_referrer_pfx');
        if(refOwnerPfx){
            _addRefCommission(refOwnerPfx, cant);
        }
        localStorage.setItem(_pfx()+'_last_withdrawal_order',JSON.stringify(withdrawalOrder));
        gemas-=cant;
        actualizarUI();
        mostrarMensaje(`✅ ${t('msg_withdraw_ok').replace('{usdt}',usdt)}`,'#00ff88');
        closeModal('modal-retiro');
        generarCaptcha();
    }

    async function comprarGemas(cantidad,usdtAmount){
        closeModal('modal-deposito');
        abrirPagoQR({
            tipo:'deposito',
            titulo:`💎 Depósito — ${cantidad.toLocaleString()} Gemas`,
            descripcion:`Depósito de gemas. El pago se envía directamente al mismo contrato inteligente usado en torneo y entrenamiento.`,
            usdt:usdtAmount,
            onConfirmar:async()=>{
                if(!isWalletConnected()){mostrarMensaje('⚠️ Conecta tu wallet','#ffaa00');openWalletModal();return false;}
                mostrarMensaje(`⏳ Procesando $${Number(usdtAmount).toFixed(2)} USDT...`,'#00d4ff');
                try{
                    const tx=await buildContractTx('deposito',usdtAmount);
                    await tonConnectUI.sendTransaction(tx);
                    gemas+=cantidad;
                    actualizarUI();
                    mostrarMensaje(`✅ +${cantidad} 💎 añadidas!`,'#00ff88');
                    return true;
                }catch(e){mostrarMensaje('❌ Depósito cancelado','#ff4444');return false;}
            }
        });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── SISTEMA DE REFERIDOS (CLOUD-BACKED, cross-device / cross-country) ─
    //
    // Migrado a Lovable Cloud (Supabase). El link funciona globalmente porque
    // el mapa refCode→wallet vive en la nube, no en localStorage.
    //   - Tabla `referrals_map`:  ref_code (PK) → pfx, wallet
    //   - Tabla `referrals_list`: owner_ref_code → referidos + comisiones
    // Las claves de gemas reclamables se mantienen en localStorage para UX
    // instantanea; el resto se sincroniza con la nube.
    // ══════════════════════════════════════════════════════════════════════

    const REF_COMISION_PCT = 0.05; // 5%
    const _REF_MAP_KEY = 'fm_refmap_'; // (legacy local, ya no es la fuente de verdad)

    // ── Cliente Supabase ──────────────────────────────────────────────────
    const SUPABASE_URL = 'https://sviccwxtulzikmieenzp.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_sHZhCkTlr09gsAS8iDOVEw_hOFYwx7r';
    let _sb = null;
    function _supa(){
        if(_sb) return _sb;
        try {
            if(window.supabase && typeof window.supabase.createClient === 'function'){
                _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: { persistSession: false, autoRefreshToken: false }
                });
            }
        } catch(e){ console.warn('[refs] supabase init failed', e); }
        return _sb;
    }

    // ── Genera o recupera el refId unico del usuario ──────────────────────
    function getMyRefId(){
        let id = localStorage.getItem(_pfx()+'_my_ref_id');
        if(id){ _registrarEnMapaGlobal(id); return id; }
        const guestId = localStorage.getItem('fm_guest_my_ref_id');
        if(guestId){
            localStorage.setItem(_pfx()+'_my_ref_id', guestId);
            _registrarEnMapaGlobal(guestId);
            return guestId;
        }
        id = 'FM' + Math.random().toString(36).substring(2,8).toUpperCase();
        localStorage.setItem(_pfx()+'_my_ref_id', id);
        _registrarEnMapaGlobal(id);
        return id;
    }

    // ── Device pfx: identificador estable por dispositivo aunque no haya wallet
    // Permite registrar referidos cross-device incluso si el usuario aun no conecto wallet TON.
    function _devicePfx(){
        let id = localStorage.getItem('fm_device_id');
        if(!id){
            id = 'dev_' + Math.random().toString(36).substring(2,10) + Date.now().toString(36);
            try { localStorage.setItem('fm_device_id', id); } catch(e){}
        }
        return 'fm_'+id;
    }
    // pfx efectivo para referidos: wallet si existe, si no el device pfx (NUNCA 'fm_guest' colectivo)
    function _refPfx(){
        const w = _walletAddr() || _activeWalletAddr;
        return _isLikelyTonWalletAddress(w) ? ('fm_'+w) : _devicePfx();
    }

    // ── Registra refCode → {pfx, wallet} en la nube ───────────────────────
    // Esto es lo que permite a otros dispositivos/paises encontrar al referidor
    async function _registrarEnMapaGlobal(refId){
        if(!refId) return;
        const pfx = _refPfx();
        const connectedWallet = _walletAddr() || _activeWalletAddr || null;
        const wallet = _isLikelyTonWalletAddress(connectedWallet) ? connectedWallet : null;
        // Cache local (compatibilidad con codigo legacy). No guardamos IDs internos como wallet pública.
        try { localStorage.setItem(_REF_MAP_KEY + refId, JSON.stringify({ pfx, wallet: wallet||null, ts: Date.now() })); } catch(e){}
        // Push a la nube (fire-and-forget). Ya no exigimos wallet ni tonProof:
        // queremos que el contador de referidos funcione desde la primera apertura.
        const sb = _supa();
        if(!sb) return;
        const pd = (typeof getStoredTonProof === 'function') ? getStoredTonProof() : null;
        const hasProof = pd && pd.proof && pd.walletAddress;
        try {
            const row = { ref_code: refId, pfx, wallet: wallet||null, updated_at: new Date().toISOString() };
            if(hasProof){
                row.ton_proof = pd.proof;
                row.proof_payload = pd.payload;
            }
            await sb.from('referrals_map').upsert(row, { onConflict: 'ref_code' });
        } catch(e){ console.warn('[refs] map upsert failed', e); }
    }

    // ── Link de invitacion (Telegram Bot deep link) ──────────────────────
    // Usamos `startapp` (NO `start`) para que Telegram abra directamente el Mini App
    // y `Telegram.WebApp.initDataUnsafe.start_param` reciba el codigo `ref_XXXX`.
    // El parametro `start` solo abre el chat del bot y el codigo se pierde.
    function getMyRefLink(){
        const refId = getMyRefId();
        return `https://t.me/futmundi_bot?startapp=ref_${refId}`;
    }
    function getMyRefLinkWeb(){
        const refId = getMyRefId();
        const base = window.location.origin + window.location.pathname;
        return `${base}?ref=${refId}`;
    }

    // ── Lista de referidos (cache local + refresh nube) ───────────────────
    function getMisReferidos(){ try{ return JSON.parse(localStorage.getItem(_pfx()+'_mis_referidos')||'[]'); }catch(e){ return []; } }
    function saveMisReferidos(arr){ localStorage.setItem(_pfx()+'_mis_referidos', JSON.stringify(arr)); }

    // Trae la lista desde la nube y actualiza el cache + UI
    async function _refrescarReferidosDesdeNube(){
        const sb = _supa();
        if(!sb) return;
        const myRefId = localStorage.getItem(_pfx()+'_my_ref_id');
        if(!myRefId) return;
        try {
            const { data, error } = await sb
                .from('referrals_list')
                .select('referred_wallet, referred_pfx, earned, joined_at')
                .eq('owner_ref_code', myRefId)
                .order('joined_at', { ascending: true });
            if(error){ console.warn('[refs] list fetch error', error); return; }
            if(!data) return;
            const refs = data.map(r => {
                const tonW = _isLikelyTonWalletAddress(r.referred_wallet) ? r.referred_wallet : '';
                const name = tonW ? _shortTonWallet(tonW) : 'Jugador';
                return { wallet: tonW, internalPfx: r.referred_pfx || '', name, nivel: 1, earned: Number(r.earned||0), fecha: r.joined_at };
            });
            saveMisReferidos(refs);
            // Actualizar total ganado historico
            const total = refs.reduce((s,r)=>s+(r.earned||0), 0);
            localStorage.setItem(_pfx()+'_ref_earned_total', total.toFixed(4));
            if(document.getElementById('modal-referidos')?.classList?.contains('active')) buildReferidosUI();
        } catch(e){ console.warn('[refs] refresh failed', e); }
    }

    // ── Gemas pendientes de reclamar (local, UX instantanea) ──────────────
    function _refClaimKey(){ return _pfx()+'_ref_claimable'; }
    function _refEarnedTotalKey(){ return _pfx()+'_ref_earned_total'; }
    function getRefClaimable(){ return parseFloat(localStorage.getItem(_refClaimKey())||'0'); }
    function getRefEarnedTotal(){ return parseFloat(localStorage.getItem(_refEarnedTotalKey())||'0'); }

    // ── Anade comision al referidor (llamado desde retirar()) ─────────────
    // Suma local (rapido) + UPDATE en la nube para que el referidor lo vea
    async function _addRefCommission(refOwnerPfx, gemasAmount){
        if(!refOwnerPfx || gemasAmount <= 0) return;
        const commission = parseFloat((gemasAmount * REF_COMISION_PCT).toFixed(4));
        // Cache local (legacy: si el referidor abre desde el mismo dispositivo)
        const currentClaimable = parseFloat(localStorage.getItem(refOwnerPfx+'_ref_claimable')||'0');
        localStorage.setItem(refOwnerPfx+'_ref_claimable', (currentClaimable + commission).toFixed(4));
        const currentTotal = parseFloat(localStorage.getItem(refOwnerPfx+'_ref_earned_total')||'0');
        localStorage.setItem(refOwnerPfx+'_ref_earned_total', (currentTotal + commission).toFixed(4));

        // Push a la nube: incrementar earned en referrals_list
        const sb = _supa();
        const myPfx = _pfx();
        const myWallet = _walletAddr() || _activeWalletAddr;
        const ownerRefCode = localStorage.getItem(myPfx+'_my_referrer_code');
        if(!sb || !ownerRefCode) return;
        try {
            const { data: rows } = await sb
                .from('referrals_list')
                .select('id, earned')
                .eq('owner_ref_code', ownerRefCode)
                .eq('referred_pfx', myPfx)
                .limit(1);
            if(rows && rows[0]){
                const newEarned = Number((Number(rows[0].earned||0) + commission).toFixed(4));
                await sb.from('referrals_list').update({ earned: newEarned, referred_wallet: myWallet||null })
                    .eq('id', rows[0].id);
            }
        } catch(e){ console.warn('[refs] commission push failed', e); }
    }

    // ── Extrae el refCode de todas las fuentes posibles ───────────────────
    function _extraerRefCode(){
        let refCode = null;
        try {
            if(window.Telegram?.WebApp?.initDataUnsafe?.start_param){
                const sp = String(Telegram.WebApp.initDataUnsafe.start_param).trim();
                if(sp.startsWith('ref_')) refCode = sp.slice(4).toUpperCase();
                else if(/^FM[A-Z0-9]{4,10}$/.test(sp)) refCode = sp;
            }
            if(!refCode){
                const params = new URLSearchParams(window.location.search);
                const candidates = [
                    params.get('start'), params.get('startapp'),
                    params.get('ref'), params.get('tgWebAppStartParam')
                ];
                for(const c of candidates){
                    if(!c) continue;
                    const s = String(c).trim();
                    if(s.startsWith('ref_')){ refCode = s.slice(4).toUpperCase(); break; }
                    if(/^FM[A-Z0-9]{4,10}$/.test(s)){ refCode = s; break; }
                }
            }
            if(!refCode && location.hash){
                const h = location.hash.replace('#','').trim();
                if(h.startsWith('ref_')) refCode = h.slice(4).toUpperCase();
                else if(/^FM[A-Z0-9]{4,10}$/.test(h)) refCode = h;
            }
            if(!refCode){
                const saved = sessionStorage.getItem('fm_pending_ref');
                if(saved) refCode = saved;
            }
        } catch(e){}
        return refCode;
    }

    // ── Detecta y registra el codigo de referido ──────────────────────────
    function _detectarReferido(){
        const refCode = _extraerRefCode();
        if(!refCode) return;
        try{ sessionStorage.setItem('fm_pending_ref', refCode); }catch(e){}
        if(refCode === localStorage.getItem(_pfx()+'_my_ref_id')) return; // no auto-referido
        const alreadySet = localStorage.getItem(_pfx()+'_my_referrer_code');
        if(alreadySet) return;
        localStorage.setItem(_pfx()+'_my_referrer_code', refCode);
        _registrarseEnReferidor(refCode);
    }

    // ── Registra al nuevo usuario como referido (en la nube) ──────────────
    async function _registrarseEnReferidor(refCode){
        if(!refCode) return;
        const myPfx = _refPfx();
        const myWallet = _walletAddr() || _activeWalletAddr || null;

        const sb = _supa();
        if(sb){
            try {
                // 1. Buscar al duenio del refCode en la nube
                const { data: owner } = await sb
                    .from('referrals_map')
                    .select('pfx, wallet')
                    .eq('ref_code', refCode)
                    .maybeSingle();
                if(owner && owner.pfx && owner.pfx !== myPfx){
                    // ANTI-FRAUDE 1: auto-referido por wallet (misma wallet referidor/referido)
                    if(myWallet && owner.wallet && String(myWallet).toLowerCase() === String(owner.wallet).toLowerCase()){
                        console.warn('[refs] auto-referido bloqueado (misma wallet)');
                        return;
                    }
                    // tonProof OPCIONAL: si esta presente lo guardamos, pero ya no bloquea el registro.
                    // De este modo el contador de referidos se incrementa desde la primera apertura,
                    // y la verificacion anti-fraude se hace al momento del retiro/pago de comision.
                    const pd = (typeof getStoredTonProof === 'function') ? getStoredTonProof() : null;
                    const hasValidProof = pd && pd.proof && myWallet &&
                        String(pd.walletAddress||'').toLowerCase() === String(myWallet).toLowerCase();
                    // ANTI-FRAUDE 3: esta wallet ya tiene un referidor (1 wallet = 1 referidor)
                    if(myWallet){
                        try {
                            const { data: existing } = await sb
                                .from('referrals_list')
                                .select('owner_ref_code')
                                .eq('referred_wallet', myWallet)
                                .limit(1)
                                .maybeSingle();
                            if(existing && existing.owner_ref_code && existing.owner_ref_code !== refCode){
                                console.warn('[refs] wallet ya registrada con otro referidor');
                                return;
                            }
                        } catch(e){}
                    }
                    // 2. Insertar en su lista (idempotente por UNIQUE(owner, referred_pfx))
                    const row = {
                        owner_ref_code: refCode,
                        referred_pfx: myPfx,
                        referred_wallet: myWallet,
                        earned: 0
                    };
                    if(hasValidProof){
                        row.ton_proof = pd.proof;
                        row.proof_payload = pd.payload;
                    }
                    await sb.from('referrals_list').upsert(
                        row,
                        { onConflict: 'owner_ref_code,referred_pfx', ignoreDuplicates: true }
                    );
                    localStorage.setItem(_pfx()+'_my_referrer_pfx', owner.pfx);
                    return; // ✅ Registrado cross-device via Cloud
                }
            } catch(e){ console.warn('[refs] cloud register failed', e); }
        }


        // Fallback offline: mismo navegador
        const myName = (myWallet && myWallet.length > 8)
            ? (myWallet.slice(0,4)+'...'+myWallet.slice(-4))
            : 'Nuevo Jugador';
        for(let i=0; i<localStorage.length; i++){
            const key = localStorage.key(i);
            if(!key || !key.endsWith('_my_ref_id')) continue;
            if(localStorage.getItem(key) !== refCode) continue;
            const ownerPfx = key.replace('_my_ref_id','');
            if(ownerPfx === myPfx) continue;
            const refs = JSON.parse(localStorage.getItem(ownerPfx+'_mis_referidos')||'[]');
            const yaExiste = refs.some(r => r.wallet === myWallet);
            if(!yaExiste){
                refs.push({ wallet: myWallet, name: myName, nivel: 1, earned: 0, fecha: new Date().toISOString(), refCode });
                localStorage.setItem(ownerPfx+'_mis_referidos', JSON.stringify(refs));
            }
            localStorage.setItem(_pfx()+'_my_referrer_pfx', ownerPfx);
            break;
        }
    }

    // ── Al conectar wallet: sincronizar con la nube ───────────────────────
    async function _resolverPendientesDeReferidos(){
        try {
            const myRefId = getMyRefId();              // dispara registro en nube
            await _registrarEnMapaGlobal(myRefId);     // asegura wallet actualizada
            // Re-intentar registro propio si quedo pendiente
            const myRefCode = localStorage.getItem(_pfx()+'_my_referrer_code');
            if(myRefCode){
                await _registrarseEnReferidor(myRefCode);
            }
            // Refrescar mis referidos desde la nube
            await _refrescarReferidosDesdeNube();
        } catch(e){ console.warn('[refs] resolve pending failed', e); }
    }

    function claimRefGems(){
        const claimable = getRefClaimable();
        const amount = parseFloat(claimable.toFixed(2));
        if(amount < 0.01){ mostrarMensaje('⏳ Aún no hay gemas para reclamar','#ffaa00'); return; }
        gemas += amount;
        localStorage.setItem(_refClaimKey(), '0');
        saveState();
        actualizarUI();
        mostrarMensaje(`✅ +${amount.toFixed(2)} 💎 de comisiones reclamadas!`, '#00ff88');
        buildReferidosUI();
    }

    function buildReferidosUI(){
        // Refresca desde la nube en background (no bloquea)
        try{ _refrescarReferidosDesdeNube(); }catch(e){}
        // Links
        const linkEl = $id('ref-link');
        if(linkEl) linkEl.value = getMyRefLink();

        const refs = getMisReferidos();
        const claimable = getRefClaimable();
        const earnedTotal = getRefEarnedTotal();

        // Contadores del tablero
        const totalEl = $id('ref-total');
        if(totalEl) totalEl.textContent = refs.length;

        const earnedEl = $id('ref-earned');
        if(earnedEl) earnedEl.textContent = earnedTotal.toFixed(2);

        // Claimable
        const claimEl = $id('ref-claimable');
        if(claimEl) claimEl.textContent = claimable.toFixed(2);

        // Botón reclamar
        const btn = $id('btn-claim-ref');
        if(btn){
            btn.disabled = claimable < 0.01;
            btn.style.opacity = claimable < 0.01 ? '0.4' : '1';
            btn.style.cursor  = claimable < 0.01 ? 'not-allowed' : 'pointer';
        }

        // Badge de conteo
        const badge = $id('ref-count-badge');
        if(badge) badge.textContent = refs.length > 0 ? `${refs.length} persona${refs.length!==1?'s':''}` : '';

        // Lista de referidos
        const list = $id('ref-list');
        if(!list) return;

        if(refs.length === 0){
            list.innerHTML = `
                <div style="text-align:center;padding:28px 12px;border:1px dashed rgba(168,85,247,0.25);border-radius:12px;">
                    <div style="font-size:2em;margin-bottom:8px;">👥</div>
                    <div style="color:#555;font-size:0.88em;line-height:1.6;">${t('ref_empty')}</div>
                    <div style="color:#444;font-size:0.78em;margin-top:6px;">Cada referido que retire gemas te da un <strong style="color:var(--gold)">5%</strong> de comisión</div>
                </div>`;
            return;
        }

        // Calcular total ganado de esta lista
        const totalEarnedFromList = refs.reduce((s,r)=>s+(r.earned||0), 0);

        list.innerHTML = refs.map((r, i) => {
            const fecha = r.fecha ? new Date(r.fecha).toLocaleDateString('es',{day:'2-digit',month:'short',year:'numeric'}) : '—';
            const earned = (r.earned||0).toFixed(2);
            const pct = totalEarnedFromList > 0 ? ((r.earned||0)/totalEarnedFromList*100).toFixed(0) : 0;
            const tonWallet = _isLikelyTonWalletAddress(r.wallet) ? r.wallet : '';
            const walletShort = tonWallet ? _shortTonWallet(tonWallet) : 'TON no vinculada';
            const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`#${i+1}`;
            return `
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(168,85,247,0.18);border-radius:11px;padding:11px 13px;transition:all 0.2s;">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                        <span style="font-size:1.1em;flex-shrink:0;">${medal}</span>
                        <div style="min-width:0;">
                            <div style="font-weight:700;font-size:0.88em;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.name||'Jugador'}</div>
                            <div style="font-family:'Orbitron',sans-serif;font-size:0.58em;color:#555;margin-top:1px;">${walletShort}</div>
                        </div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div style="font-family:'Orbitron',sans-serif;font-size:0.78em;color:var(--gold);font-weight:700;">+${earned} 💎</div>
                        <div style="font-size:0.62em;color:#555;margin-top:2px;">${fecha}</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <div style="flex:1;height:4px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--purple),var(--cyan));border-radius:4px;transition:width 0.5s;"></div>
                    </div>
                    <div style="font-size:0.65em;color:#666;flex-shrink:0;">${pct}% del total</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
                    <div style="background:linear-gradient(135deg,var(--purple),var(--cyan));color:#fff;border-radius:20px;padding:2px 10px;font-family:'Orbitron',sans-serif;font-size:0.62em;font-weight:700;flex-shrink:0;">Niv ${r.nivel||1}</div>
                    <div style="font-size:0.68em;color:#555;">${t('ref_earned_from')}: <strong style="color:var(--gold)">${earned} 💎</strong> · comisión <strong style="color:var(--purple)">5%</strong></div>
                </div>
            </div>`;
        }).join('');
    }

    function copiarRefLink(inputId, btnId){
        inputId = inputId || 'ref-link';
        const input = $id(inputId);
        if(!input) return;
        const link = input.value;
        const btn = btnId ? $id(btnId) : null;
        const originalHTML = btn ? btn.innerHTML : null;
        const originalBg = btn ? btn.style.background : null;
        const _restore = ()=>{ if(btn){ btn.innerHTML=originalHTML; btn.style.background=originalBg; } };
        const _ok = ()=>{
            mostrarMensaje('📋 '+t('ref_copied'),'#00d4ff');
            if(btn){ btn.innerHTML='✅ Copiado!'; btn.style.background='var(--green)'; setTimeout(_restore,2000); }
        };
        try{
            if(navigator.clipboard && navigator.clipboard.writeText){
                navigator.clipboard.writeText(link).then(_ok).catch(()=>{ input.select(); document.execCommand('copy'); _ok(); });
            } else { input.select(); document.execCommand('copy'); _ok(); }
        } catch(e){ mostrarMensaje('⚠️ Copia manual el link','#ffaa00'); }
    }

    function compartirRefTelegram(){
        const link = getMyRefLink();
        const texto = encodeURIComponent('⚽ ¡Únete a FUTMUNDI! El juego de fútbol NFT más épico. Gana TON y USDT jugando. Entra por mi link: ' + link);
        window.open('https://t.me/share/url?url='+encodeURIComponent(link)+'&text='+texto, '_blank');
    }

    function compartirRefWhatsApp(){
        // Usa el link web para máxima compatibilidad en WhatsApp
        const link = getMyRefLinkWeb();
        const texto = encodeURIComponent('⚽ ¡Juega FUTMUNDI conmigo! Gana cripto real jugando fútbol NFT en la blockchain TON. Entra aquí: ' + link);
        window.open('https://wa.me/?text='+texto, '_blank');
    }

    function compartirRefNativo(){
        const link = getMyRefLink();
        const webLink = getMyRefLinkWeb();
        if(navigator.share){
            navigator.share({
                title: '⚽ FUTMUNDI - Juego NFT de Fútbol',
                text: '¡Únete a FUTMUNDI! Gana cripto real jugando fútbol NFT en la blockchain TON.',
                url: link
            }).catch(()=>{
                // Fallback: copiar el link web
                navigator.clipboard?.writeText(webLink).then(()=>mostrarMensaje('📋 Link copiado para compartir','#00d4ff'));
            });
        } else {
            // Si no hay Web Share API, copiar el link web
            navigator.clipboard?.writeText(webLink)
                .then(()=>mostrarMensaje('📋 Link copiado — pégalo donde quieras!','#00d4ff'))
                .catch(()=>mostrarMensaje('📋 Copia el link web de arriba','#ffaa00'));
        }
    }

    function toggleQRReferido(){
        const container = $id('ref-qr-container');
        if(!container) return;
        if(container.style.display !== 'none'){
            container.style.display = 'none';
            return;
        }
        container.style.display = 'block';
        const canvas = $id('ref-qr-canvas');
        if(!canvas) return;
        // Usar link Telegram como QR primario (Telegram no está bloqueado en la mayoría de países)
        const link = getMyRefLink();
        if(typeof QRCode !== 'undefined'){
            try{
                QRCode.toCanvas(canvas, link, { width:180, margin:2, color:{ dark:'#000000', light:'#ffffff' } });
            } catch(e){ container.innerHTML += '<p style="color:#888;font-size:0.8em;">QR no disponible, copia el link</p>'; }
        } else {
            // Fallback: img tag con API pública de QR
            const img = document.createElement('img');
            img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data='+encodeURIComponent(link);
            img.style.cssText = 'border-radius:8px;max-width:180px;display:block;margin:0 auto;';
            canvas.style.display = 'none';
            canvas.parentNode.insertBefore(img, canvas.nextSibling);
        }
        container.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    // ── IDIOMAS ───────────────────────────────────────────────────────────
    const TRANSLATIONS={
        es:{tagline:'El juego de fútbol NFT más épico del mundo',menu_futbolistas:'👕 Futbolistas',menu_marketplace:'🏪 Marketplace',menu_recompensas:'⚽ Recompensas',menu_recompensa_diaria:'🎁 Recompensa Diaria',menu_logros:'🏅 Logros',menu_nivel:'⬆️ Nivel',menu_futcancha:'🏟️ FutCancha',menu_futsala:'🏃 Futsala',menu_torneo:'🏆 Torneo',menu_ranking:'📊 Ranking',menu_entrenamiento:'🏋️ Entrenamiento',menu_deposito:'💎 Depósito',menu_retiro:'💸 Retiro',balones_estamina:'⚽ Balones de Estamina',balones:'balones',referidos_btn:'👥 Referidos',ref_title:'👥 Programa de Referidos',ref_commission:'💰 GANA 5% DE COMISIÓN',ref_explain:'Recibe el <strong style="color:var(--gold)">5%</strong> en gemas de cada retiro que realice tu referido. ¡Para siempre!',ref_total_label:'REFERIDOS',ref_earned_label:'GANADO',ref_link_label:'Tu enlace de invitación',ref_copy:'Copiar',ref_list_title:'📋 MIS REFERIDOS',ref_empty:'Aún no tienes referidos. ¡Comparte tu enlace!',ref_earned_from:'Generado',ref_copied:'Enlace copiado',msg_addr_req:'⚠️ Ingresa tu dirección USDT',msg_min:'❌ Mínimo 160 💎',msg_insuf:'❌ Saldo insuficiente',msg_captcha:'🛡️ Captcha incorrecto, intenta de nuevo',msg_withdraw_ok:'Retiro de {usdt} USDT solicitado — se acreditará en 24h a 48h'},
        en:{tagline:"The world's most epic NFT football game",menu_futbolistas:'👕 Players',menu_marketplace:'🏪 Marketplace',menu_recompensas:'⚽ Rewards',menu_recompensa_diaria:'🎁 Daily Reward',menu_logros:'🏅 Achievements',menu_nivel:'⬆️ Level',menu_futcancha:'🏟️ FutPitch',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Tournament',menu_ranking:'📊 Ranking',menu_entrenamiento:'🏋️ Training',menu_deposito:'💎 Deposit',menu_retiro:'💸 Withdraw',balones_estamina:'⚽ Stamina Balls',balones:'balls',referidos_btn:'👥 Referrals',ref_title:'👥 Referral Program',ref_commission:'💰 EARN 5% COMMISSION',ref_explain:'Get <strong style="color:var(--gold)">5%</strong> in gems from every withdrawal your referral makes. Forever!',ref_total_label:'REFERRALS',ref_earned_label:'EARNED',ref_link_label:'Your invitation link',ref_copy:'Copy',ref_list_title:'📋 MY REFERRALS',ref_empty:'No referrals yet. Share your link!',ref_earned_from:'Generated',ref_copied:'Link copied',msg_addr_req:'⚠️ Enter your USDT address',msg_min:'❌ Minimum 160 💎',msg_insuf:'❌ Insufficient balance',msg_captcha:'🛡️ Wrong captcha, try again',msg_withdraw_ok:'Withdrawal of {usdt} USDT requested — credited within 24h to 48h'},
        pt:{tagline:'O jogo de futebol NFT mais épico do mundo',menu_futbolistas:'👕 Jogadores',menu_marketplace:'🏪 Mercado',menu_recompensas:'⚽ Recompensas',menu_recompensa_diaria:'🎁 Recompensa Diária',menu_logros:'🏅 Conquistas',menu_nivel:'⬆️ Nível',menu_futcancha:'🏟️ FutCampo',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Torneio',menu_ranking:'📊 Ranking',menu_entrenamiento:'🏋️ Treino',menu_deposito:'💎 Depósito',menu_retiro:'💸 Saque',balones_estamina:'⚽ Bolas de Estamina',balones:'bolas',referidos_btn:'👥 Indicações',ref_title:'👥 Programa de Indicações',ref_commission:'💰 GANHE 5% DE COMISSÃO',ref_explain:'Receba <strong style="color:var(--gold)">5%</strong> em gemas de cada saque do seu indicado. Para sempre!',ref_total_label:'INDICAÇÕES',ref_earned_label:'GANHO',ref_link_label:'Seu link de convite',ref_copy:'Copiar',ref_list_title:'📋 MEUS INDICADOS',ref_empty:'Sem indicados ainda. Compartilhe seu link!',ref_earned_from:'Gerado',ref_copied:'Link copiado',msg_addr_req:'⚠️ Insira seu endereço USDT',msg_min:'❌ Mínimo 160 💎',msg_insuf:'❌ Saldo insuficiente',msg_captcha:'🛡️ Captcha errado, tente novamente',msg_withdraw_ok:'Saque de {usdt} USDT solicitado — creditado em 24h a 48h'},
        fr:{tagline:'Le jeu de football NFT le plus épique du monde',menu_futbolistas:'👕 Joueurs',menu_marketplace:'🏪 Marché',menu_recompensas:'⚽ Récompenses',menu_recompensa_diaria:'🎁 Récompense Quotidienne',menu_logros:'🏅 Succès',menu_nivel:'⬆️ Niveau',menu_futcancha:'🏟️ FutTerrain',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Tournoi',menu_ranking:'📊 Classement',menu_entrenamiento:'🏋️ Entraînement',menu_deposito:'💎 Dépôt',menu_retiro:'💸 Retrait',balones_estamina:'⚽ Balles d\u2019Endurance',balones:'balles',referidos_btn:'👥 Parrainage',ref_title:'👥 Programme de Parrainage',ref_commission:'💰 GAGNEZ 5% DE COMMISSION',ref_explain:'Recevez <strong style="color:var(--gold)">5%</strong> en gemmes de chaque retrait de votre filleul. Pour toujours!',ref_total_label:'FILLEULS',ref_earned_label:'GAGNÉ',ref_link_label:'Votre lien d\u2019invitation',ref_copy:'Copier',ref_list_title:'📋 MES FILLEULS',ref_empty:'Aucun filleul. Partagez votre lien!',ref_earned_from:'Généré',ref_copied:'Lien copié',msg_addr_req:'⚠️ Entrez votre adresse USDT',msg_min:'❌ Minimum 160 💎',msg_insuf:'❌ Solde insuffisant',msg_captcha:'🛡️ Captcha incorrect, réessayez',msg_withdraw_ok:'Retrait de {usdt} USDT demandé — crédité sous 24h à 48h'},
        de:{tagline:'Das epischste NFT-Fußballspiel der Welt',menu_futbolistas:'👕 Spieler',menu_marketplace:'🏪 Marktplatz',menu_recompensas:'⚽ Belohnungen',menu_recompensa_diaria:'🎁 Tägliche Belohnung',menu_logros:'🏅 Erfolge',menu_nivel:'⬆️ Stufe',menu_futcancha:'🏟️ FutPlatz',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Turnier',menu_ranking:'📊 Rangliste',menu_entrenamiento:'🏋️ Training',menu_deposito:'💎 Einzahlung',menu_retiro:'💸 Auszahlung',balones_estamina:'⚽ Ausdauerbälle',balones:'Bälle',referidos_btn:'👥 Empfehlungen',ref_title:'👥 Empfehlungsprogramm',ref_commission:'💰 5% PROVISION VERDIENEN',ref_explain:'Erhalte <strong style="color:var(--gold)">5%</strong> in Gems von jeder Auszahlung deines Empfohlenen. Für immer!',ref_total_label:'EMPFOHLENE',ref_earned_label:'VERDIENT',ref_link_label:'Dein Einladungslink',ref_copy:'Kopieren',ref_list_title:'📋 MEINE EMPFOHLENEN',ref_empty:'Noch keine Empfohlenen. Teile deinen Link!',ref_earned_from:'Generiert',ref_copied:'Link kopiert',msg_addr_req:'⚠️ Gib deine USDT-Adresse ein',msg_min:'❌ Minimum 160 💎',msg_insuf:'❌ Saldo unzureichend',msg_captcha:'🛡️ Captcha falsch, erneut versuchen',msg_withdraw_ok:'Auszahlung von {usdt} USDT angefordert — gutgeschrieben in 24h bis 48h'},
        it:{tagline:'Il gioco di calcio NFT più epico del mondo',menu_futbolistas:'👕 Calciatori',menu_marketplace:'🏪 Mercato',menu_recompensas:'⚽ Ricompense',menu_recompensa_diaria:'🎁 Ricompensa Giornaliera',menu_logros:'🏅 Obiettivi',menu_nivel:'⬆️ Livello',menu_futcancha:'🏟️ FutCampo',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Torneo',menu_ranking:'📊 Classifica',menu_entrenamiento:'🏋️ Allenamento',menu_deposito:'💎 Deposito',menu_retiro:'💸 Prelievo',balones_estamina:'⚽ Palloni di Stamina',balones:'palloni',referidos_btn:'👥 Referral',ref_title:'👥 Programma Referral',ref_commission:'💰 GUADAGNA 5% DI COMMISSIONE',ref_explain:'Ricevi <strong style="color:var(--gold)">5%</strong> in gemme da ogni prelievo del tuo referral. Per sempre!',ref_total_label:'REFERRAL',ref_earned_label:'GUADAGNATO',ref_link_label:'Il tuo link di invito',ref_copy:'Copia',ref_list_title:'📋 I MIEI REFERRAL',ref_empty:'Nessun referral. Condividi il tuo link!',ref_earned_from:'Generato',ref_copied:'Link copiato',msg_addr_req:'⚠️ Inserisci il tuo indirizzo USDT',msg_min:'❌ Minimo 160 💎',msg_insuf:'❌ Saldo insufficiente',msg_captcha:'🛡️ Captcha errato, riprova',msg_withdraw_ok:'Prelievo di {usdt} USDT richiesto — accreditato in 24h-48h'},
        ja:{tagline:'世界で最もエピックなNFTサッカーゲーム',menu_futbolistas:'👕 選手',menu_marketplace:'🏪 マーケット',menu_recompensas:'⚽ 報酬',menu_recompensa_diaria:'🎁 デイリー報酬',menu_logros:'🏅 実績',menu_nivel:'⬆️ レベル',menu_futcancha:'🏟️ フットピッチ',menu_futsala:'🏃 フットサル',menu_torneo:'🏆 トーナメント',menu_ranking:'📊 ランキング',menu_entrenamiento:'🏋️ トレーニング',menu_deposito:'💎 入金',menu_retiro:'💸 出金',balones_estamina:'⚽ スタミナボール',balones:'ボール',referidos_btn:'👥 紹介',ref_title:'👥 紹介プログラム',ref_commission:'💰 5%コミッション獲得',ref_explain:'紹介者の出金額の<strong style="color:var(--gold)">5%</strong>をジェムで永久に受け取れます！',ref_total_label:'紹介数',ref_earned_label:'獲得',ref_link_label:'あなたの招待リンク',ref_copy:'コピー',ref_list_title:'📋 私の紹介者',ref_empty:'まだ紹介者がいません。リンクを共有しましょう！',ref_earned_from:'生成',ref_copied:'リンクをコピーしました',msg_addr_req:'⚠️ USDTアドレスを入力',msg_min:'❌ 最小160 💎',msg_insuf:'❌ 残高不足',msg_captcha:'🛡️ キャプチャが違います',msg_withdraw_ok:'{usdt} USDTの出金リクエスト — 24〜48時間以内に入金'},
        sv:{tagline:'Världens mest episka NFT-fotbollsspel',menu_futbolistas:'👕 Spelare',menu_marketplace:'🏪 Marknad',menu_recompensas:'⚽ Belöningar',menu_recompensa_diaria:'🎁 Daglig Belöning',menu_logros:'🏅 Prestationer',menu_nivel:'⬆️ Nivå',menu_futcancha:'🏟️ FutPlan',menu_futsala:'🏃 Futsal',menu_torneo:'🏆 Turnering',menu_ranking:'📊 Ranking',menu_entrenamiento:'🏋️ Träning',menu_deposito:'💎 Insättning',menu_retiro:'💸 Uttag',balones_estamina:'⚽ Stamina-bollar',balones:'bollar',referidos_btn:'👥 Värvningar',ref_title:'👥 Värvningsprogram',ref_commission:'💰 TJÄNA 5% PROVISION',ref_explain:'Få <strong style="color:var(--gold)">5%</strong> i ädelstenar från varje uttag din värvning gör. För alltid!',ref_total_label:'VÄRVNINGAR',ref_earned_label:'INTJÄNAT',ref_link_label:'Din inbjudningslänk',ref_copy:'Kopiera',ref_list_title:'📋 MINA VÄRVNINGAR',ref_empty:'Inga värvningar än. Dela din länk!',ref_earned_from:'Genererat',ref_copied:'Länk kopierad',msg_addr_req:'⚠️ Ange din USDT-adress',msg_min:'❌ Minst 160 💎',msg_insuf:'❌ Otillräckligt saldo',msg_captcha:'🛡️ Fel captcha, försök igen',msg_withdraw_ok:'Uttag på {usdt} USDT begärt — krediteras inom 24-48 tim'}
    };
    let _currentLang=localStorage.getItem('tg_lang')||'es';
    function t(key){return (TRANSLATIONS[_currentLang]&&TRANSLATIONS[_currentLang][key])||TRANSLATIONS.es[key]||key;}
    function applyTranslations(){
        document.querySelectorAll('[data-i18n]').forEach(el=>{const k=el.getAttribute('data-i18n');const v=t(k);if(v)el.innerHTML=v;});
        const refModal=$id('modal-referidos');if(refModal&&refModal.classList.contains('active'))buildReferidosUI();
    }
    function toggleLangDropdown(){const dd=$id('lang-dropdown');const btn=$id('lang-toggle-btn');dd.classList.toggle('open');btn.classList.toggle('open');}
    function setLang(lang,flag,code){
        _currentLang=lang;
        localStorage.setItem('tg_lang',lang);
        document.getElementById('current-lang-label').textContent=flag+' '+code;
        document.querySelectorAll('.lang-option').forEach(o=>o.classList.remove('active'));
        if(typeof event!=='undefined'&&event&&event.currentTarget)event.currentTarget.classList.add('active');
        document.getElementById('lang-dropdown').classList.remove('open');
        document.getElementById('lang-toggle-btn').classList.remove('open');
        document.documentElement.lang=lang;
        applyTranslations();
    }
    document.addEventListener('click',e=>{const wrap=$id('lang-dropdown-wrap');if(wrap&&!wrap.contains(e.target)){$id('lang-dropdown')?.classList.remove('open');$id('lang-toggle-btn')?.classList.remove('open');}});
    (function restoreLang(){
        const langMap={es:['🇪🇸','ES'],en:['🇬🇧','EN'],pt:['🇵🇹','PT'],fr:['🇫🇷','FR'],de:['🇩🇪','DE'],it:['🇮🇹','IT'],ja:['🇯🇵','JA'],sv:['🇸🇪','SV']};
        const m=langMap[_currentLang];if(m){const lbl=document.getElementById('current-lang-label');if(lbl)lbl.textContent=m[0]+' '+m[1];document.querySelectorAll('.lang-option').forEach(o=>{const oc=o.getAttribute('onclick')||'';o.classList.toggle('active',oc.includes(`'${_currentLang}'`));});document.documentElement.lang=_currentLang;}
        applyTranslations();
    })();

    // ── BACKGROUND ────────────────────────────────────────────────────────
    const FLAG_DATA=[{flag:'🇧🇷',lane:5},{flag:'🇦🇷',lane:18},{flag:'🇵🇹',lane:31},{flag:'🇬🇧',lane:44},{flag:'🇫🇷',lane:57},{flag:'🇩🇪',lane:70},{flag:'🇪🇸',lane:83},{flag:'🇺🇸',lane:10},{flag:'🇲🇽',lane:24},{flag:'🇯🇵',lane:37},{flag:'🇨🇴',lane:63},{flag:'🇦🇺',lane:90},{flag:'🇮🇹',lane:15},{flag:'🇳🇱',lane:50},{flag:'🇰🇷',lane:75},{flag:'🇨🇱',lane:30}];
    function buildFlagsBg(){const bg=$id('flags-bg');FLAG_DATA.forEach((item,i)=>{const el=document.createElement('div');el.className='flag-float';el.textContent=item.flag;el.style.cssText=`left:${item.lane}%;animation-duration:${18+i*2.8}s;animation-delay:${-(i*3.1)}s;`;bg.appendChild(el);});[8,22,38,52,68,82,12,45,77].forEach((lane,i)=>{const el=document.createElement('div');el.className='ball-float';el.textContent='⚽';el.style.cssText=`left:${lane}%;top:${15+i*9}%;animation-duration:${6+i*1.5}s;animation-delay:${-(i*0.8)}s;font-size:${1.2+(i%3)*0.4}em;`;bg.appendChild(el);});}
    buildFlagsBg();

    // ── PAGO QR (CONTRATO INTELIGENTE) ────────────────────────────────────
    let _pagoQRPendiente = null;
    function abrirPagoQR({tipo,titulo,descripcion,usdt,onConfirmar}){
        const flow = assertSecureContractFlow(tipo,getContractWallet());
        const amount = Number(usdt);
        if(!Number.isFinite(amount) || amount<=0){mostrarMensaje('❌ Monto de pago inválido','#ff4444');return;}
        _pagoQRPendiente = {tipo:flow.tipo,usdt:amount,address:flow.address,onConfirmar};
        $id('pago-qr-title').textContent = titulo || '💳 Pago al Contrato Inteligente';
        $id('pago-qr-desc').textContent  = descripcion || '';
        $id('pago-qr-amount').textContent = amount.toFixed(2);
        $id('pago-qr-ton').textContent    = "+ 0.05 TON (Tarifa de Red Gas)";
        $id('pago-qr-address').textContent = flow.address;
        
        const USDT_MASTER = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
        const memo = encodeURIComponent(`FUTMUNDI_${flow.tipo.toUpperCase()}`);
        const qrPayload = `ton://transfer/${flow.address}?jetton=${USDT_MASTER}&amount=${Math.round(amount*1e6)}&text=${memo}`;
        const canvas = $id('pago-qr-canvas');
        if(window.QRCode && canvas){
            QRCode.toCanvas(canvas, qrPayload, {width:220, margin:1, color:{dark:'#000', light:'#fff'}}, err=>{
                if(err) console.warn('QR error',err);
            });
        }
        openModal('modal-pago-qr');
    }
    function copiarDireccionContrato(){
        const addr = getContractWallet();
        if(!isValidTonAddress(addr)){mostrarMensaje('❌ Contrato inválido','#ff4444');return;}
        if(navigator.clipboard){
            navigator.clipboard.writeText(addr).then(
                ()=>mostrarMensaje('📋 Dirección copiada','#00ff88'),
                ()=>mostrarMensaje('⚠️ No se pudo copiar','#ffaa00')
            );
        } else {
            const ta=document.createElement('textarea');ta.value=addr;document.body.appendChild(ta);ta.select();
            try{document.execCommand('copy');mostrarMensaje('📋 Dirección copiada','#00ff88');}catch(e){mostrarMensaje('⚠️ No se pudo copiar','#ffaa00');}
            document.body.removeChild(ta);
        }
    }
    async function confirmarPagoQR(){
        if(!_pagoQRPendiente) return;
        try{assertSecureContractFlow(_pagoQRPendiente.tipo,_pagoQRPendiente.address);}catch(e){mostrarMensaje('❌ Pago bloqueado: contrato no coincide','#ff4444');return;}
        const btn = $id('pago-qr-confirm-btn');
        const original = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '⏳ Procesando...';
        try{
            const ok = await _pagoQRPendiente.onConfirmar();
            if(ok) closeModal('modal-pago-qr');
        } finally {
            btn.disabled = false; btn.innerHTML = original;
        }
    }

    // ── TONCONNECT ────────────────────────────────────────────────────────
    let tonConnectUI;
    function getConnectedWallet(){return tonConnectUI?.wallet||tonConnectUI?.account||tonConnectUI?.walletInfo||null;}
    function isWalletConnected(){return Boolean(window.tonConnectUI&&(tonConnectUI.connected||getConnectedWallet()?.account?.address||getConnectedWallet()?.address));}
    function openWalletModal(){if(window.tonConnectUI&&typeof tonConnectUI.openModal==='function')tonConnectUI.openModal();}
    // ── ANTI-FRAUDE TON: payload firmable por la wallet (tonProof) ─────────
    // Genera un nonce único por sesión; la wallet lo firma al conectar,
    // demostrando criptográficamente que el usuario controla la private key.
    function _genProofPayload(){
        let p = sessionStorage.getItem('fm_ton_proof_payload');
        if(p) return p;
        const rnd = (crypto?.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b=>b.toString(16).padStart(2,'0')).join('') : Math.random().toString(36).slice(2));
        p = 'futmundi_ref_' + Date.now().toString(36) + '_' + rnd;
        try{ sessionStorage.setItem('fm_ton_proof_payload', p); }catch(e){}
        return p;
    }
    window._tonProofData = null;        // { proof, payload, walletAddress }
    function getStoredTonProof(){
        if(window._tonProofData) return window._tonProofData;
        try {
            const raw = localStorage.getItem(_pfx()+'_ton_proof');
            return raw ? JSON.parse(raw) : null;
        } catch(e){ return null; }
    }
    try{
        tonConnectUI=new TON_CONNECT_UI.TonConnectUI({manifestUrl:'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/tonconnect-manifest.json',buttonRootId:'ton-connect-button'});
        window.tonConnectUI=tonConnectUI;
        // Pide a la wallet que firme el payload al conectar (tonProof)
        try {
            tonConnectUI.setConnectRequestParameters({
                state: 'ready',
                value: { tonProof: _genProofPayload() }
            });
        } catch(e){ console.warn('[tonProof] setConnectRequestParameters failed', e); }
        tonConnectUI.onStatusChange(w=>{
            const addr=w?.account?.address||w?.address||null;
            // Capturar tonProof si la wallet lo entregó
            try {
                const items = w?.connectItems;
                const proofItem = items?.tonProof;
                if(proofItem && proofItem.proof){
                    const payload = _genProofPayload();
                    window._tonProofData = { proof: proofItem.proof, payload, walletAddress: addr };
                    try { localStorage.setItem(_pfx()+'_ton_proof', JSON.stringify(window._tonProofData)); } catch(e){}
                    // Re-emitir proof_payload con nuevo nonce para la próxima conexión
                    try { sessionStorage.removeItem('fm_ton_proof_payload'); } catch(e){}
                    try {
                        tonConnectUI.setConnectRequestParameters({
                            state: 'ready',
                            value: { tonProof: _genProofPayload() }
                        });
                    } catch(e){}
                }
            } catch(e){ console.warn('[tonProof] capture failed', e); }
            onWalletChange(addr);
        });
    }
    catch(e){console.warn('TonConnect no disponible:',e);}

    // ── TELEGRAM ──────────────────────────────────────────────────────────
    if(window.Telegram?.WebApp){Telegram.WebApp.ready();Telegram.WebApp.expand();Telegram.WebApp.setHeaderColor('#060f06');Telegram.WebApp.setBackgroundColor('#060f06');}

    // ── INIT ──────────────────────────────────────────────────────────────
    // Estado inicial: arranca en 0 hasta que el usuario conecte su wallet.
    // Al conectar, onWalletChange() carga los datos de esa wallet específica.
    resetStateVars();
    actualizarUI();
    buildMarket();
    buildUniforms();
    buildSkillLogros();
    buildFutsalaBody();
    updateTorneoCountdown();
    // Detectar código de referido en la URL al cargar la página
    try{ _detectarReferido(); _resolverPendientesDeReferidos(); }catch(e){}

    if(!CanvasRenderingContext2D.prototype.roundRect){CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){this.beginPath();this.moveTo(x+r,y);this.lineTo(x+w-r,y);this.quadraticCurveTo(x+w,y,x+w,y+r);this.lineTo(x+w,y+h-r);this.quadraticCurveTo(x+w,y+h,x+w-r,y+h);this.lineTo(x+r,y+h);this.quadraticCurveTo(x,y+h,x,y+h-r);this.lineTo(x,y+r);this.quadraticCurveTo(x,y,x+r,y);this.closePath();};}

    // ════════════════════════════════════════════════════════
    // 🎲 SISTEMA DE APUESTAS MUNDIAL — RapidAPI Football + USDT
    // ════════════════════════════════════════════════════════
    const RAPIDAPI_KEY  = '5297cd7741msh18be9a82f0c0005p186a64jsn95c14debaff6';
    const RAPIDAPI_HOST = 'free-api-live-football-data.p.rapidapi.com';
    const AP_DB_KEY = () => 'fm_apuestas_' + (typeof walletAddr !== 'undefined' && walletAddr ? walletAddr : 'guest');

    // Estado de apuesta en curso
    let _apPartidoSeleccionado = null;
    let _apResultadoElegido    = null;  // 'local'|'empate'|'visita'
    let _apCuotaActual         = 1.0;
    let _apPartidosCache       = [];

    // ── BASE DE DATOS LOCAL (localStorage) ──────────────────
    function apDB_getTickets()  { try { return JSON.parse(localStorage.getItem(AP_DB_KEY())||'[]'); } catch(e){ return []; } }
    function apDB_saveTickets(t){ localStorage.setItem(AP_DB_KEY(), JSON.stringify(t)); }
    function apDB_addTicket(tk) {
        const tickets = apDB_getTickets();
        tickets.unshift(tk);
        apDB_saveTickets(tickets.slice(0, 100)); // máx 100 tickets por usuario
    }
    function apDB_updateTicket(id, changes) {
        const tickets = apDB_getTickets();
        const idx = tickets.findIndex(t => t.id === id);
        if (idx >= 0) { Object.assign(tickets[idx], changes); apDB_saveTickets(tickets); }
    }

    // ── TABS ─────────────────────────────────────────────────
    function apTabSwitch(tab) {
        ['partidos','mistickets'].forEach(t => {
            $id('ap-tab-'+t).style.display = t === tab ? 'block' : 'none';
            const btn = $id('tab-btn-'+t);
            if(btn){ btn.classList.toggle('active', t === tab); }
        });
        if (tab === 'mistickets') apRenderTickets();
    }

    // ── CARGAR PARTIDOS VÍA API ──────────────────────────────
    async function apCargarPartidos() {
        const statusEl = $id('ap-status');
        const listaEl  = $id('ap-partidos-lista');
        if(!statusEl || !listaEl) return;

        statusEl.innerHTML = '⏳ Cargando partidos del Mundial…';
        listaEl.innerHTML  = '';
        $id('ap-panel-confirmar').style.display = 'none';
        _apPartidoSeleccionado = null;
        _apResultadoElegido    = null;

        const btn = $id('ap-refresh-btn');
        if(btn){ btn.disabled = true; btn.textContent = '⏳'; }

        try {
            // Endpoint: partidos en vivo primero, luego próximos
            const endpoints = [
                'football-current-live',
                'football-get-all-fixtures-by-date?date=' + new Date().toISOString().slice(0,10)
            ];

            let partidos = [];
            for (const ep of endpoints) {
                try {
                    const res  = await fetch(`https://${RAPIDAPI_HOST}/${ep}`, {
                        method: 'GET',
                        headers: {
                            'x-rapidapi-key':  RAPIDAPI_KEY,
                            'x-rapidapi-host': RAPIDAPI_HOST,
                            'Content-Type':    'application/json'
                        }
                    });
                    const data = await res.json();
                    // Normalizar respuesta (distintos endpoints tienen distinta estructura)
                    const items = data?.response?.fixtures || data?.response?.matches
                                || data?.response?.livescores || data?.response || [];
                    if (Array.isArray(items) && items.length) {
                        partidos = partidos.concat(items);
                    }
                } catch(e){ /* continuar con siguiente endpoint */ }
            }

            // Si la API no devuelve nada (límite de plan gratis), mostrar partidos de demo
            if (!partidos.length) {
                partidos = apGenerarPartidosDemo();
            }

            _apPartidosCache = partidos.slice(0, 12);
            apRenderPartidos(_apPartidosCache);
            statusEl.innerHTML = `✅ ${_apPartidosCache.length} partidos disponibles`;

        } catch(err) {
            console.error('apCargarPartidos error:', err);
            // Fallback: partidos de demo si hay error de red
            _apPartidosCache = apGenerarPartidosDemo();
            apRenderPartidos(_apPartidosCache);
            statusEl.innerHTML = '⚠️ Usando partidos de ejemplo (sin conexión)';
        } finally {
            if(btn){ btn.disabled = false; btn.textContent = '🔄 Actualizar'; }
        }
    }

    // ── PARTIDOS DE DEMO (cuando la API no retorna datos) ────
    function apGenerarPartidosDemo() {
        const hoy = new Date();
        const fmt  = d => d.toISOString().slice(0,10);
        const hora  = h => { const d = new Date(hoy); d.setHours(h,0,0,0); return d.toISOString(); };
        return [
            { _id:'d1', local:'🇦🇷 Argentina', visita:'🇫🇷 Francia',      hora:hora(14), estado:'live',     marcador:'1-1', cuotas:{local:2.1, empate:3.4, visita:2.8} },
            { _id:'d2', local:'🇧🇷 Brasil',    visita:'🇩🇪 Alemania',     hora:hora(17), estado:'live',     marcador:'0-0', cuotas:{local:1.9, empate:3.6, visita:3.1} },
            { _id:'d3', local:'🇪🇸 España',    visita:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Inglaterra',   hora:hora(20), estado:'proximo', marcador:null,  cuotas:{local:2.0, empate:3.3, visita:2.9} },
            { _id:'d4', local:'🇵🇹 Portugal',  visita:'🇺🇾 Uruguay',      hora:hora(22), estado:'proximo', marcador:null,  cuotas:{local:1.7, empate:3.8, visita:4.2} },
            { _id:'d5', local:'🇳🇱 Holanda',   visita:'🇲🇦 Marruecos',    hora:hora(16), estado:'proximo', marcador:null,  cuotas:{local:2.3, empate:3.1, visita:3.0} },
            { _id:'d6', local:'🇯🇵 Japón',     visita:'🇭🇷 Croacia',      hora:hora(18), estado:'proximo', marcador:null,  cuotas:{local:2.8, empate:3.2, visita:2.4} },
        ];
    }

    // ── NORMALIZAR PARTIDO (múltiples formatos de API) ───────
    function apCalcularCuotas(localStr, visitaStr) {
        const _STRENGTH = {
            'argentina': 95, 'francia': 94, 'brasil': 93, 'inglaterra': 90, 'españa': 89, 'portugal': 88, 'alemania': 87, 
            'holanda': 86, 'italia': 85, 'belgica': 84, 'croacia': 83, 'uruguay': 82, 'colombia': 81, 'marruecos': 80,
            'suiza': 78, 'dinamarca': 77, 'senegal': 76, 'japon': 75, 'ecuador': 74, 'usa': 73, 'eeuu': 73, 'mexico': 72, 'chile': 71,
            'peru': 70, 'paraguay': 69, 'venezuela': 68, 'bolivia': 60, 'qatar': 55, 'arabia': 55, 'costa rica': 65
        };

        const getS = t => {
            const n = String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            for(let key in _STRENGTH) { if(n.includes(key)) return _STRENGTH[key]; }
            // Fuerza aleatoria determinista si el equipo no está en la lista (basado en el nombre)
            let hash = 0;
            for(let i=0; i<n.length; i++) hash = ((hash << 5) - hash) + n.charCodeAt(i);
            return 65 + (Math.abs(hash) % 16); // Entre 65 y 80
        };

        const sL = getS(localStr);
        const sV = getS(visitaStr);
        const diff = sL - sV;

        let probL = 0.37 + (diff * 0.012);
        let probV = 0.37 - (diff * 0.012);
        let probE = 0.26 - (Math.abs(diff) * 0.004);

        probL = Math.max(0.05, Math.min(0.9, probL));
        probV = Math.max(0.05, Math.min(0.9, probV));
        probE = Math.max(0.05, Math.min(0.4, probE));

        const total = probL + probV + probE;
        probL /= total; probV /= total; probE /= total;

        const margen = 0.93; // 7% house edge (beneficio del juego)
        return {
            local: +(margen / probL).toFixed(2),
            empate: +(margen / probE).toFixed(2),
            visita: +(margen / probV).toFixed(2)
        };
    }

    function apNormalizarPartido(raw, idx) {
        // Si ya es formato demo, devolverlo tal cual
        if (raw._id) return raw;
        // Formato RapidAPI Free Football Data
        const home = raw.home?.name || raw.homeTeam?.name || raw.teams?.home?.name || raw.localTeam?.name || 'Local';
        const away = raw.away?.name || raw.awayTeam?.name || raw.teams?.away?.name || raw.visitorTeam?.name || 'Visita';
        const time  = raw.time || raw.fixture?.date || raw.date || new Date().toISOString();
        const status= (raw.status || raw.fixture?.status?.short || '').toLowerCase();
        const isLive= ['1h','ht','2h','et','bt','p','live','in play'].some(s => status.includes(s));
        const goalsH= raw.scores?.home || raw.goals?.home || raw.score?.home || '';
        const goalsA= raw.scores?.away || raw.goals?.away || raw.score?.away || '';
        const marcador = (goalsH !== '' && goalsA !== '') ? `${goalsH}-${goalsA}` : null;
        
        return {
            _id: raw.id || raw.fixture?.id || ('p'+idx),
            local: home, visita: away,
            hora:  time,
            estado: isLive ? 'live' : 'proximo',
            marcador,
            cuotas: apCalcularCuotas(home, away)
        };
    }

    // ── RENDERIZAR LISTA DE PARTIDOS ─────────────────────────
    function apRenderPartidos(rawList) {
        const el = $id('ap-partidos-lista');
        if (!el) return;
        if (!rawList.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:#666;font-size:0.88em;">No hay partidos disponibles en este momento.</div>'; return; }
        el.innerHTML = rawList.map((raw, i) => {
            const p = apNormalizarPartido(raw, i);
            const esLive = p.estado === 'live';
            const hora   = new Date(p.hora).toLocaleTimeString('es', {hour:'2-digit',minute:'2-digit'});
            return `
            <div class="ap-partido-card" id="appc-${i}" onclick="apSeleccionarPartido(${i})">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        ${esLive ? '<span class="ap-partido-live">EN VIVO</span>' : `<span style="font-size:0.72em;color:#888;">⏰ ${hora}</span>`}
                        ${p.marcador ? `<span style="font-family:'Orbitron',sans-serif;font-size:0.82em;color:var(--gold);font-weight:700;">${p.marcador}</span>` : ''}
                    </div>
                    <span style="font-size:0.65em;color:#555;">ID: ${p._id}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin-bottom:10px;">
                    <div style="font-weight:700;font-size:0.9em;color:#fff;text-align:left;">${p.local}</div>
                    <div style="font-family:'Orbitron',sans-serif;font-size:0.75em;color:#666;">VS</div>
                    <div style="font-weight:700;font-size:0.9em;color:#fff;text-align:right;">${p.visita}</div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;">
                    <div style="text-align:center;background:rgba(0,0,0,0.3);border-radius:6px;padding:5px 2px;">
                        <div style="font-size:0.6em;color:#888;">LOCAL</div>
                        <div style="font-family:'Orbitron',sans-serif;color:var(--cyan);font-size:0.82em;font-weight:700;">${p.cuotas.local}x</div>
                    </div>
                    <div style="text-align:center;background:rgba(0,0,0,0.3);border-radius:6px;padding:5px 2px;">
                        <div style="font-size:0.6em;color:#888;">EMPATE</div>
                        <div style="font-family:'Orbitron',sans-serif;color:var(--gold);font-size:0.82em;font-weight:700;">${p.cuotas.empate}x</div>
                    </div>
                    <div style="text-align:center;background:rgba(0,0,0,0.3);border-radius:6px;padding:5px 2px;">
                        <div style="font-size:0.6em;color:#888;">VISITA</div>
                        <div style="font-family:'Orbitron',sans-serif;color:var(--green);font-size:0.82em;font-weight:700;">${p.cuotas.visita}x</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    // ── SELECCIONAR PARTIDO ──────────────────────────────────
    function apSeleccionarPartido(idx) {
        document.querySelectorAll('.ap-partido-card').forEach(c => c.classList.remove('selected'));
        const card = $id('appc-'+idx);
        if(card) card.classList.add('selected');

        const raw = _apPartidosCache[idx];
        _apPartidoSeleccionado = apNormalizarPartido(raw, idx);
        _apResultadoElegido    = null;
        _apCuotaActual         = 1.0;

        // Rellenar info del partido en el panel
        const p = _apPartidoSeleccionado;
        $id('ap-panel-partido').innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div style="font-weight:700;color:#fff;font-size:0.9em;">${p.local}</div>
                <div style="font-size:0.7em;color:#666;font-family:'Orbitron',sans-serif;">VS</div>
                <div style="font-weight:700;color:#fff;font-size:0.9em;text-align:right;">${p.visita}</div>
            </div>`;

        // Etiquetas de los botones de elección
        $id('ap-pick-local').innerHTML  = `${p.local}<br><span style="font-family:'Orbitron',sans-serif;color:var(--cyan);font-size:0.85em;">${p.cuotas.local}x</span>`;
        $id('ap-pick-empate').innerHTML = `🤝 Empate<br><span style="font-family:'Orbitron',sans-serif;color:var(--gold);font-size:0.85em;">${p.cuotas.empate}x</span>`;
        $id('ap-pick-visita').innerHTML = `${p.visita}<br><span style="font-family:'Orbitron',sans-serif;color:var(--green);font-size:0.85em;">${p.cuotas.visita}x</span>`;

        ['ap-pick-local','ap-pick-empate','ap-pick-visita'].forEach(id => { const b=$id(id); if(b) b.classList.remove('active'); });
        $id('ap-monto-input').value  = '';
        $id('ap-cuota-display').textContent    = '—';
        $id('ap-ganancia-display').textContent = '$0.00';

        const panel = $id('ap-panel-confirmar');
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior:'smooth', block:'nearest' });
    }

    // ── ELEGIR LOCAL / EMPATE / VISITA ──────────────────────
    function apElegirResultado(opcion) {
        if (!_apPartidoSeleccionado) return;
        _apResultadoElegido = opcion;
        _apCuotaActual      = _apPartidoSeleccionado.cuotas[opcion];
        ['local','empate','visita'].forEach(o => {
            const b = $id('ap-pick-'+o);
            if(b) b.classList.toggle('active', o === opcion);
        });
        $id('ap-cuota-display').textContent = _apCuotaActual + 'x';
        apActualizarGanancia();
    }

    // ── MONTO RÁPIDO ─────────────────────────────────────────
    function apSetMonto(val) {
        $id('ap-monto-input').value = val;
        apActualizarGanancia();
    }

    // ── CALCULAR GANANCIA ────────────────────────────────────
    function apActualizarGanancia() {
        const monto = parseFloat($id('ap-monto-input').value) || 0;
        const gan   = (monto * _apCuotaActual).toFixed(2);
        $id('ap-ganancia-display').textContent = monto > 0 ? '$' + gan : '$0.00';
    }

    // ── CANCELAR PANEL ───────────────────────────────────────
    function apCancelarPanel() {
        $id('ap-panel-confirmar').style.display = 'none';
        document.querySelectorAll('.ap-partido-card').forEach(c => c.classList.remove('selected'));
        _apPartidoSeleccionado = null;
        _apResultadoElegido    = null;
    }

    // ── CONFIRMAR APUESTA → PAGO USDT ────────────────────────
    function apConfirmarApuesta() {
        if (!_apPartidoSeleccionado) { mostrarMensaje('⚠️ Selecciona un partido primero', '#ffaa00'); return; }
        if (!_apResultadoElegido)    { mostrarMensaje('⚠️ Elige tu pronóstico (Local / Empate / Visita)', '#ffaa00'); return; }
        const monto = parseFloat($id('ap-monto-input').value) || 0;
        if (monto < 1)               { mostrarMensaje('⚠️ Mínimo $1 USDT para apostar', '#ffaa00'); return; }

        const p        = _apPartidoSeleccionado;
        const ganancia = parseFloat((monto * _apCuotaActual).toFixed(2));
        const labels   = { local: 'Gana ' + p.local, empate: 'Empate', visita: 'Gana ' + p.visita };
        const ticketId = 'TK-' + Date.now() + '-' + Math.floor(Math.random()*9999);

        const ticket = {
            id:         ticketId,
            partidoId:  p._id,
            local:      p.local,
            visita:     p.visita,
            pronostico: _apResultadoElegido,
            label:      labels[_apResultadoElegido],
            cuota:      _apCuotaActual,
            montoUsdt:  monto,
            gananciaUsdt: ganancia,
            estado:     'pendiente',
            wallet:     (typeof walletAddr !== 'undefined' ? walletAddr : 'guest'),
            fecha:      new Date().toLocaleString('es',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short',year:'numeric'}),
            fechaISO:   new Date().toISOString(),
        };

        // Abrir modal de pago QR (mismo flujo que depósito/torneo)
        abrirPagoQR({
            tipo: 'apuesta',
            titulo: `🎲 Apuesta — ${p.local} vs ${p.visita}`,
            descripcion: `Pronóstico: ${labels[_apResultadoElegido]} · Cuota ${_apCuotaActual}x · Ganancia potencial $${ganancia} USDT`,
            usdt: monto,
            onConfirmar: async () => {
                if (!isWalletConnected()) { mostrarMensaje('⚠️ Conecta tu wallet TON primero', '#ffaa00'); openWalletModal(); return false; }
                mostrarMensaje(`⏳ Procesando $${monto.toFixed(2)} USDT…`, '#00d4ff');
                try {
                    const tx = await buildContractTx('apuesta', monto);
                    await tonConnectUI.sendTransaction(tx);
                    // ✅ Pago confirmado → guardar ticket en DB
                    ticket.estado    = 'pagada';
                    ticket.txFecha   = new Date().toISOString();
                    apDB_addTicket(ticket);
                    mostrarMensaje(`🎫 ¡Ticket #${ticketId} registrado! Monto: $${monto} USDT`, '#42f58d');
                    apCancelarPanel();
                    apTabSwitch('mistickets');
                    return true;
                } catch(e) {
                    mostrarMensaje('❌ Pago cancelado o fallido', '#ff4444');
                    return false;
                }
            }
        });
    }

    // ── RENDERIZAR MIS TICKETS ───────────────────────────────
    function apRenderTickets() {
        const el      = $id('ap-tickets-lista');
        if (!el) return;
        const tickets = apDB_getTickets();

        if (!tickets.length) {
            el.innerHTML = `<div style="text-align:center;padding:32px;color:#666;font-size:0.88em;line-height:1.7;">
                No tienes tickets registrados aún.<br>
                <span style="font-size:1.5em;">🎫</span><br>
                Selecciona un partido y realiza tu primera apuesta en USDT.</div>`;
            return;
        }

        const estadoIcon  = { pendiente:'⏳', pagada:'⏳', ganada:'✅', perdida:'❌', anulada:'↩️' };
        const estadoColor = { pendiente:'#ffd84d', pagada:'#ffd84d', ganada:'#42f58d', perdida:'#ff5a6f', anulada:'#888' };

        el.innerHTML = tickets.map(t => {
            const ic = estadoIcon[t.estado]  || '⏳';
            const co = estadoColor[t.estado] || '#888';
            return `
            <div class="ap-ticket-card ${t.estado === 'ganada' ? 'ganada' : t.estado === 'perdida' ? 'perdida' : 'pendiente'}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                    <div>
                        <div style="font-size:0.72em;color:#888;font-family:'Orbitron',sans-serif;letter-spacing:1px;margin-bottom:3px;">${t.id}</div>
                        <div style="font-weight:700;font-size:0.9em;color:#fff;">${t.local} <span style="color:#666;font-size:0.8em;">vs</span> ${t.visita}</div>
                        <div style="font-size:0.78em;color:var(--cyan);margin-top:3px;">📌 ${t.label} · Cuota ${t.cuota}x</div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;margin-left:8px;">
                        <div style="font-size:0.82em;color:${co};font-weight:700;">${ic} ${(t.estado||'').toUpperCase()}</div>
                        <div style="font-size:0.65em;color:#666;margin-top:3px;">${t.fecha}</div>
                    </div>
                </div>
                <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(0,0,0,0.25);border-radius:8px;font-size:0.82em;">
                    <span style="color:#888;">Apostado: <strong style="color:var(--gold);">$${t.montoUsdt} USDT</strong></span>
                    <span style="color:#888;">Potencial: <strong style="color:var(--green);">$${t.gananciaUsdt} USDT</strong></span>
                </div>
            </div>`;
        }).join('');
    }

    // ── VERIFICACIÓN AUTOMÁTICA DE TICKETS ───────────────────
    async function apVerificarTicketsGanadores() {
        const tickets = apDB_getTickets();
        const pendientes = tickets.filter(t => t.estado === 'pagada' || t.estado === 'pendiente');
        if (!pendientes.length) return;

        let huboCambios = false;
        let gemasGanadas = 0;

        for (const t of pendientes) {
            try {
                // Evitamos fechas indefinidas si el ticket es viejo
                const d = (t.fechaISO || new Date().toISOString()).slice(0,10);
                const res = await fetch(`https://${RAPIDAPI_HOST}/football-get-all-fixtures-by-date?date=${d}`, {
                    headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST }
                });
                const data = await res.json();
                const items = data?.response?.fixtures || data?.response?.matches || data?.response || [];
                
                const partido = items.find(p => (p.id || p.fixture?.id) == t.partidoId);
                if (!partido) continue;

                const status = (partido.status || partido.fixture?.status?.short || '').toUpperCase();
                if (status === 'FT' || status === 'AET' || status === 'PEN' || status === 'FINISHED') {
                    const goalsH = partido.scores?.home ?? partido.goals?.home ?? partido.score?.fulltime?.home ?? partido.score?.home ?? 0;
                    const goalsA = partido.scores?.away ?? partido.goals?.away ?? partido.score?.fulltime?.away ?? partido.score?.away ?? 0;
                    
                    let resultadoReal = 'empate';
                    if (goalsH > goalsA) resultadoReal = 'local';
                    if (goalsH < goalsA) resultadoReal = 'visita';

                    if (t.pronostico === resultadoReal) {
                        t.estado = 'ganada';
                        const premioGemas = parseFloat((t.gananciaUsdt * 32).toFixed(2));
                        gemasGanadas += premioGemas;
                        huboCambios = true;
                    } else {
                        t.estado = 'perdida';
                        huboCambios = true;
                    }
                }
            } catch (e) { console.error('Error verificando ticket', e); }
        }

        if (huboCambios) {
            apDB_saveTickets(tickets);
            apRenderTickets();
            if (gemasGanadas > 0) {
                gemas += gemasGanadas;
                if(typeof saveState === 'function') saveState();
                if(typeof actualizarUI === 'function') actualizarUI();
                setTimeout(() => {
                    mostrarMensaje(`🎉 ¡Acertaste apuestas! +${gemasGanadas.toFixed(1)} 💎 añadidas a tu saldo.`, '#42f58d');
                }, 1000);
            }
        }
    }

    // ── HOOK: cuando se abre el modal ────────────────────────
    const _apOrigOpen = openModal;
    openModal = function(id) {
        _apOrigOpen(id);
        if (id === 'modal-apuesta') {
            apTabSwitch('partidos');
            apCargarPartidos();
            apuestaCheckFecha(); // verificar si ya se habilitaron las apuestas
            apVerificarTicketsGanadores(); // Verificar tickets ganadores
        }
        if (id === 'modal-torneo') {
            updateTorneoCountdown();
            torneoTabSwitch('info');
        }
    };
    // ════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  APUESTAS MUNDIAL — BLOQUEO HASTA 11 JUNIO 2026
// ═══════════════════════════════════════════════════════════════
const FECHA_INICIO_MUNDIAL = new Date('2026-06-11T00:00:00Z'); // 11 de junio 2026 UTC

// ═══════════════════════════════════════════════════════════════
//  ADMIN: ENVIAR REGALO NFT — buscar wallet por código de referido
//  (BLOQUE GLOBAL — fuera de cualquier función)
// ═══════════════════════════════════════════════════════════════
(function(){
    const ADMIN_GIFT_WALLET = 'UQB9uFaCgM5HVntXHe-mq3xYiYjcLEzvgnZUCffNC5DR-7vg';

    function _friendlyToRawTon(s){
        try{
            s = String(s||'').trim().replace(/-/g,'+').replace(/_/g,'/');
            const bin = atob(s);
            if(bin.length !== 36) return null;
            const wc = bin.charCodeAt(1) > 127 ? bin.charCodeAt(1)-256 : bin.charCodeAt(1);
            let hex='';
            for(let i=2;i<34;i++) hex += bin.charCodeAt(i).toString(16).padStart(2,'0');
            return wc + ':' + hex;
        }catch(e){ return null; }
    }
    function _normalizeTonAddr(a){
        if(!a) return null;
        a = String(a).trim();
        if(a.includes(':')) return a.toLowerCase();
        const r = _friendlyToRawTon(a);
        return r ? r.toLowerCase() : a.toLowerCase();
    }
    const _ADMIN_RAW = _normalizeTonAddr(ADMIN_GIFT_WALLET);

    function _getWallet(){
        try{
            if(typeof window.currentWalletAddr === 'function') return window.currentWalletAddr();
            const tc = window.tonConnectUI;
            const w = tc?.wallet || tc?.account;
            return w?.account?.address || w?.address || null;
        }catch(e){ return null; }
    }
    function _esAdmin(){
        const w = _getWallet();
        return !!w && _normalizeTonAddr(w) === _ADMIN_RAW;
    }
    function _togglePanel(){
        const el = document.getElementById('admin-gift-panel');
        if(!el) return;
        el.style.display = _esAdmin() ? 'block' : 'none';
        // apply the styled class so CSS takes effect
        if(_esAdmin()) el.classList.add('admin-gift-panel-wrap');
    }
    window._toggleAdminGiftPanel = _togglePanel;

    function _getSb(){
        try{
            if(typeof window._supa === 'function'){ const s = window._supa(); if(s) return s; }
            if(window._sb) return window._sb;
            if(window.supabase && typeof window.SUPABASE_URL === 'string'){
                return window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { auth:{ persistSession:false, autoRefreshToken:false } });
            }
        }catch(e){}
        return null;
    }

    // ── State for gift session ────────────────────────────────────────────
    let _adminGiftTargetWallet = null;
    let _adminGiftTargetPfx    = null;
    let _adminGiftSelectedNFT  = null; // { idx, rarity, name, img, hp, gemMin, gemMax }

    window.adminBuscarWalletReferido = async function(){
        const inp = document.getElementById('admin-gift-code');
        const out = document.getElementById('admin-gift-result');
        if(!inp || !out) return;
        const code = (inp.value||'').trim().toUpperCase();
        out.style.display = 'block';
        if(!code){
            out.innerHTML = '<div style="color:var(--red);font-size:0.82em;padding:8px;">⚠️ Ingresa un código de referido</div>';
            return;
        }
        out.innerHTML = '<div style="color:#888;font-size:0.82em;padding:8px;">⏳ Buscando en la base de datos...</div>';
        // Hide NFT section while searching
        const nftSection = document.getElementById('admin-nft-select-section');
        if(nftSection) nftSection.style.display = 'none';
        _adminGiftTargetWallet = null;
        _adminGiftSelectedNFT  = null;

        try{
            const sb = _getSb();
            if(!sb){
                out.innerHTML = '<div style="color:var(--red);font-size:0.82em;padding:8px;">❌ Base de datos no disponible</div>';
                return;
            }
            const { data, error } = await sb
                .from('referrals_map')
                .select('ref_code, wallet, pfx')
                .eq('ref_code', code)
                .maybeSingle();
            if(error){
                out.innerHTML = '<div style="color:var(--red);font-size:0.82em;padding:8px;">❌ Error: '+(error.message||'desconocido')+'</div>';
                return;
            }
            if(!data){
                out.innerHTML = '<div style="color:var(--orange);font-size:0.82em;padding:8px;">🔎 No se encontró ningún jugador con ese código</div>';
                return;
            }
            const rawWallet = String(data.wallet || '').trim();
            const internalPfx = data.pfx || '';
            
            // La billetera interna mostrada solo al admin
            const internalWallet = internalPfx ? internalPfx.replace(/^fm_/, '') : '';
            
            // Si data.wallet tiene ALGO guardado (que no sea "null"), lo mostramos siempre.
            // Así evitamos que la validación estricta oculte billeteras reales.
            let tonWallet = '';
            if (rawWallet && rawWallet !== 'null' && rawWallet !== 'undefined' && rawWallet !== 'guest') {
                tonWallet = rawWallet;
            } else if (_isLikelyTonWalletAddress(internalWallet)) {
                tonWallet = internalWallet;
            }

            if(!tonWallet && !internalWallet){
                out.innerHTML = '<div style="color:var(--orange);font-size:0.82em;padding:8px;">⚠️ Jugador encontrado pero sin wallet ni id interno registrado.</div>';
                return;
            }

            // Store targets for gift transfer
            // - _adminGiftTargetPfx     = a quién se le acredita el NFT internamente (siempre el pfx)
            // - _adminGiftTargetWallet  = wallet TON con la que queda enlazado el NFT (si existe);
            //                             si no hay TON, usamos el internalWallet como fallback de enlace.
            _adminGiftTargetPfx    = internalPfx || ('fm_'+tonWallet);
            _adminGiftTargetWallet = tonWallet || internalWallet;

            const safeTon = (tonWallet||'').replace(/"/g,'&quot;');
            const safeInt = (internalWallet||'').replace(/"/g,'&quot;');

            const tonBlock = tonWallet ? `
                <div style="margin-top:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(66,245,141,0.4);border-radius:10px;padding:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <div style="font-family:'Orbitron',sans-serif;font-size:0.62em;color:var(--green);letter-spacing:2px;">🔗 TON WALLET (TonConnect)</div>
                        <div style="font-size:0.55em;color:#42f58d;font-weight:800;">VINCULADA</div>
                    </div>
                    <div style="font-family:'Orbitron',sans-serif;font-size:0.72em;color:#fff;word-break:break-all;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;line-height:1.4;">${safeTon}</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px;">
                        <button onclick="adminCopiarWalletGift('${safeTon}', this)"
                            style="background:linear-gradient(135deg,var(--cyan),#2bb6ff);border:none;border-radius:7px;color:#001a22;font-weight:800;font-size:0.72em;padding:7px;cursor:pointer;font-family:'Fredoka',sans-serif;">📋 Copiar TON</button>
                        <a href="https://tonkeeper.com/transfer/${encodeURIComponent(tonWallet)}" target="_blank" rel="noopener"
                            style="background:linear-gradient(135deg,var(--gold),var(--orange));border:none;border-radius:7px;color:#1a1100;font-weight:800;font-size:0.72em;padding:7px;text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;font-family:'Fredoka',sans-serif;">🔗 Tonkeeper</a>
                    </div>
                </div>` : `
                <div style="margin-top:10px;background:rgba(0,0,0,0.4);border:1px dashed rgba(255,159,28,0.4);border-radius:10px;padding:10px;">
                    <div style="font-family:'Orbitron',sans-serif;font-size:0.62em;color:var(--orange);letter-spacing:2px;margin-bottom:4px;">🔗 TON WALLET</div>
                    <div style="font-size:0.72em;color:#aaa;">⚠️ El jugador aún no ha conectado TonConnect. El NFT se enlazará a su billetera interna y se asociará automáticamente a su TON cuando la conecte.</div>
                </div>`;

            const intBlock = internalWallet ? `
                <div style="margin-top:8px;background:rgba(0,0,0,0.4);border:1px solid rgba(85,215,255,0.4);border-radius:10px;padding:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <div style="font-family:'Orbitron',sans-serif;font-size:0.62em;color:var(--cyan);letter-spacing:2px;">🏦 BILLETERA INTERNA (FUTMUNDI)</div>
                        <div style="font-size:0.55em;color:#55d7ff;font-weight:800;">GENERADA</div>
                    </div>
                    <div style="font-family:'Orbitron',sans-serif;font-size:0.72em;color:#fff;word-break:break-all;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;line-height:1.4;">${safeInt}</div>
                    <button onclick="adminCopiarWalletGift('${safeInt}', this)"
                        style="margin-top:7px;width:100%;background:linear-gradient(135deg,#55d7ff,#2bb6ff);border:none;border-radius:7px;color:#001a22;font-weight:800;font-size:0.72em;padding:7px;cursor:pointer;font-family:'Fredoka',sans-serif;">📋 Copiar billetera interna</button>
                </div>` : '';

            out.innerHTML = `
                <div style="background:rgba(0,0,0,0.35);border:1px solid rgba(66,245,141,0.35);border-radius:10px;padding:12px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                        <div style="font-family:'Orbitron',sans-serif;font-size:0.7em;color:var(--green);letter-spacing:2px;">✅ JUGADOR ENCONTRADO</div>
                        <div style="font-size:0.62em;color:#888;">${code}</div>
                    </div>
                    ${tonBlock}
                    ${intBlock}
                </div>`;

            // Show NFT selection grid (envia la TON si existe, si no la interna)
            adminRenderNFTInventory(_adminGiftTargetWallet);
        }catch(e){
            out.innerHTML = '<div style="color:var(--red);font-size:0.82em;padding:8px;">❌ '+(e.message||'Error inesperado')+'</div>';
        }
    };

    // ═══════════════════════════════════════════════════════════════════════
    //  ADMIN NFT INVENTORY — 100 physical duplicates of EVERY blueprint
    //  (futbolistas, uniformes, zapatillas, entrenadores) seeded with
    //  owner_id:'Admin'. Each row is an individual NFT instance that can
    //  be transferred 1:1 to a user (owner_id swap).
    // ═══════════════════════════════════════════════════════════════════════
    const ADMIN_INV_LS_KEY  = 'futmundi_admin_inventory_v1';
    const ADMIN_DUPES       = 100;
    const ADMIN_OWNER_ID    = 'Admin';
    const GITHUB_BASE       = 'https://raw.githubusercontent.com/squadgamernft-star/FUTMUNDI/main/image/';

    function _rarityFromHp(hp){
        if(hp>=97) return { label:'⭐ LEYENDA',  border:'rgba(255,215,0,0.8)' };
        if(hp>=93) return { label:'💎 ÉPICO',    border:'rgba(181,108,255,0.7)' };
        if(hp>=88) return { label:'🔥 RARO',     border:'rgba(255,140,0,0.7)' };
        if(hp>=82) return { label:'✨ POCO COM.', border:'rgba(0,212,255,0.5)' };
        return { label:'⚪ COMÚN', border:'rgba(255,255,255,0.15)' };
    }

    // Build the seed inventory from the four marketplace blueprints.
    // category: 'futbolista' | 'zapatilla' | 'uniforme' | 'entrenador'
    function _buildAdminInventorySeed(){
        const rows = [];
        let rowId = 1;
        const PL = (typeof window.PLAYERS    !== 'undefined') ? window.PLAYERS    : (typeof PLAYERS    !== 'undefined' ? PLAYERS    : []);
        const ZP = (typeof window.ZAPATILLAS !== 'undefined') ? window.ZAPATILLAS : (typeof ZAPATILLAS !== 'undefined' ? ZAPATILLAS : []);
        const UN = (typeof window.UNIFORMES  !== 'undefined') ? window.UNIFORMES  : (typeof UNIFORMES  !== 'undefined' ? UNIFORMES  : []);
        const EN = (typeof window.ENTRENADORES!== 'undefined')? window.ENTRENADORES:(typeof ENTRENADORES!== 'undefined'? ENTRENADORES: []);

        PL.forEach((p, idx) => {
            const rar = _rarityFromHp(p.hp);
            for(let d=0; d<ADMIN_DUPES; d++){
                rows.push({
                    row_id:        'ADMIN-FUT-'+idx+'-'+d+'-'+(rowId++),
                    owner_id:      ADMIN_OWNER_ID,
                    category:      'futbolista',
                    blueprint_idx: idx,
                    blueprint_id:  null,
                    name:          p.nombre,
                    flag:          p.flag || '',
                    img:           p.img || '',
                    ovr:           p.hp,
                    rarity:        rar.label,
                    rarity_border: rar.border,
                    gem_min:       p.gemMin,
                    gem_max:       p.gemMax,
                    durability:    100,
                    pvp_eligible:        true,
                    tournament_eligible: true,
                    tournament_fee_paid: false,
                    is_gift_origin: true,
                });
            }
        });
        ZP.forEach((it, idx) => {
            for(let d=0; d<ADMIN_DUPES; d++){
                rows.push({
                    row_id:        'ADMIN-ZAP-'+idx+'-'+d+'-'+(rowId++),
                    owner_id:      ADMIN_OWNER_ID,
                    category:      'zapatilla',
                    blueprint_idx: idx,
                    blueprint_id:  null,
                    name:          it.nombre,
                    flag:          it.flag || '👟',
                    img:           it.img || '',
                    bonus_pct:     it.bonus,
                    anio:          it.anio,
                    rarity:        'ZAPATILLA +'+it.bonus+'%',
                    rarity_border: 'rgba(0,255,136,0.5)',
                    gem_min:       null,
                    gem_max:       null,
                    durability:    100,
                    pvp_eligible:        true,
                    tournament_eligible: true,
                    tournament_fee_paid: false,
                    is_gift_origin: true,
                });
            }
        });
        UN.forEach((u) => {
            for(let d=0; d<ADMIN_DUPES; d++){
                rows.push({
                    row_id:        'ADMIN-UNI-'+u.id+'-'+d+'-'+(rowId++),
                    owner_id:      ADMIN_OWNER_ID,
                    category:      'uniforme',
                    blueprint_idx: null,
                    blueprint_id:  u.id,
                    name:          u.nombre,
                    flag:          u.emoji || '👕',
                    img:           u.img || '',
                    tier:          u.tier,
                    tier_color:    u.tierColor,
                    tier_border:   u.tierBorder,
                    fisico:        u.fisico,
                    rarity:        u.tier,
                    rarity_border: u.tierBorder,
                    gem_min:       null,
                    gem_max:       null,
                    durability:    100,
                    pvp_eligible:        true,
                    tournament_eligible: true,
                    tournament_fee_paid: false,
                    is_gift_origin: true,
                });
            }
        });
        EN.forEach((it, idx) => {
            for(let d=0; d<ADMIN_DUPES; d++){
                rows.push({
                    row_id:        'ADMIN-ENT-'+idx+'-'+d+'-'+(rowId++),
                    owner_id:      ADMIN_OWNER_ID,
                    category:      'entrenador',
                    blueprint_idx: idx,
                    blueprint_id:  null,
                    name:          it.nombre,
                    flag:          it.flag || '🏋️',
                    img:           it.img || '',
                    pais:          it.pais,
                    bonus_pct:     it.bonus,
                    rarity:        'ENTRENADOR +'+it.bonus+'%',
                    rarity_border: 'rgba(255,159,28,0.55)',
                    gem_min:       null,
                    gem_max:       null,
                    durability:    100,
                    pvp_eligible:        true,
                    tournament_eligible: true,
                    tournament_fee_paid: false,
                    is_gift_origin: true,
                });
            }
        });
        return rows;
    }

    function _loadAdminInventory(){
        try{
            const raw = localStorage.getItem(ADMIN_INV_LS_KEY);
            if(raw){
                const arr = JSON.parse(raw);
                if(Array.isArray(arr) && arr.length) return arr;
            }
        }catch(e){}
        const seed = _buildAdminInventorySeed();
        try{ localStorage.setItem(ADMIN_INV_LS_KEY, JSON.stringify(seed)); }catch(e){}
        return seed;
    }
    function _saveAdminInventory(arr){
        try{ localStorage.setItem(ADMIN_INV_LS_KEY, JSON.stringify(arr)); }catch(e){}
    }
    // Force-rebuild if catalog sizes changed (new blueprint added) — keeps 100 dupes guarantee per blueprint.
    function _adminBlueprintKey(r){
        return r.category + '|' + (r.blueprint_id != null ? r.blueprint_id : r.blueprint_idx);
    }

    function _ensureAdminInventoryFresh(){
        const inv = _loadAdminInventory();
        const seed = _buildAdminInventorySeed();
        const seededIds = new Set(seed.map(r => r.row_id));
        const cleaned = inv.filter(r => r.owner_id !== ADMIN_OWNER_ID || seededIds.has(r.row_id));
        if(cleaned.length !== inv.length){
            _saveAdminInventory(cleaned);
            return _ensureAdminInventoryFresh();
        }
        const existingIds = new Set(inv.map(r => r.row_id));
        const totalByBlueprint = {};
        inv.forEach(r => {
            const k = _adminBlueprintKey(r);
            totalByBlueprint[k] = (totalByBlueprint[k] || 0) + 1;
        });

        // Solo agregamos filas si aparece un blueprint nuevo o si faltan unidades físicas.
        // NO reponemos unidades ya transferidas: esas siguen contando dentro de su blueprint,
        // pero dejan de tener owner_id='Admin', por eso el stock visible baja de 100 a 99.
        const additions = [];
        seed.forEach(r => {
            const k = _adminBlueprintKey(r);
            if((totalByBlueprint[k] || 0) >= ADMIN_DUPES) return;
            if(existingIds.has(r.row_id)) return;
            additions.push(r);
            existingIds.add(r.row_id);
            totalByBlueprint[k] = (totalByBlueprint[k] || 0) + 1;
        });
        if(additions.length){
            inv.push(...additions);
            _saveAdminInventory(inv);
        }
        return inv;
    }
    window.ADMIN_INVENTORY_RESEED = function(){
        try{ localStorage.removeItem(ADMIN_INV_LS_KEY); }catch(e){}
        return _ensureAdminInventoryFresh();
    };

    // Active sub-tab inside the admin gift picker.
    let _adminGiftCategory = 'futbolista';

    // ── Render the multi-category admin inventory grid ───────────────────
    function adminRenderNFTInventory(recipientWallet){
        const section  = document.getElementById('admin-nft-select-section');
        const grid     = document.getElementById('admin-nft-grid');
        const preview  = document.getElementById('admin-gift-preview');
        const giftBtn  = document.getElementById('admin-do-gift-btn');
        const logEl    = document.getElementById('admin-gift-log');
        const recBanner= document.getElementById('admin-gift-recipient-banner');
        const recWallet= document.getElementById('admin-gift-recipient-wallet');
        if(!section || !grid) return;

        _adminGiftSelectedNFT = null;
        if(preview)   preview.classList.remove('visible');
        if(giftBtn)   giftBtn.disabled = true;
        if(logEl)     logEl.textContent = '';
        if(recBanner) recBanner.style.display = 'block';
        if(recWallet){
            const targetW = _adminGiftTargetWallet || recipientWallet || '';
            const tonW = _isLikelyTonWalletAddress(targetW) ? targetW : '';
            const intW = (_adminGiftTargetPfx||'').replace(/^fm_/,'') || (!_isLikelyTonWalletAddress(targetW) ? targetW : '');
            const sameAsInt = (tonW && tonW === intW);
            recWallet.innerHTML =
                `<div style="margin-bottom:4px;"><span style="color:var(--green);font-weight:700;">🔗 TON:</span> <span style="color:#fff;">${tonW||'<i style=\'color:#888\'>no conectada</i>'}</span></div>`+
                (intW && !sameAsInt ? `<div><span style="color:var(--cyan);font-weight:700;">🏦 Interna:</span> <span style="color:#fff;">${intW}</span></div>` : '');
        }
        section.style.display = 'block';

        const inv = _ensureAdminInventoryFresh();
        const cats = [
            { key:'futbolista', label:'🧑 Futbolistas' },
            { key:'zapatilla',  label:'👟 Zapatillas' },
            { key:'uniforme',   label:'👕 Uniformes' },
            { key:'entrenador', label:'🏋️ Entrenadores' },
        ];

        // Category tab bar
        let tabsHtml = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">';
        cats.forEach(c => {
            const adminCount = inv.filter(r => r.owner_id === ADMIN_OWNER_ID && r.category === c.key).length;
            const active = (c.key === _adminGiftCategory);
            tabsHtml += `<button onclick="adminGiftSwitchCategory('${c.key}')" style="
                flex:1;min-width:120px;padding:8px 10px;border-radius:9px;cursor:pointer;
                font-family:'Orbitron',sans-serif;font-size:0.66em;letter-spacing:1.5px;
                background:${active?'linear-gradient(135deg,rgba(255,215,77,0.22),rgba(255,159,28,0.18))':'rgba(0,0,0,0.35)'};
                border:1px solid ${active?'var(--gold)':'rgba(255,255,255,0.08)'};
                color:${active?'var(--gold)':'#aaa'};text-transform:uppercase;">
                ${c.label}<br><span style="font-size:0.85em;opacity:0.85">×${adminCount}</span>
            </button>`;
        });
        tabsHtml += '</div>';

        // Filter blueprints in the active category, group by blueprint to render one card per blueprint with admin-stock count.
        const adminRows = inv.filter(r => r.owner_id === ADMIN_OWNER_ID && r.category === _adminGiftCategory);
        if(!adminRows.length){
            grid.innerHTML = tabsHtml + '<div style="grid-column:1/-1;text-align:center;color:#666;font-size:0.8em;padding:20px;">El Admin no tiene stock en esta categoría.</div>';
            return;
        }

        // Group by blueprint key
        const groups = {};
        adminRows.forEach(r => {
            const k = r.category + '|' + (r.blueprint_id != null ? r.blueprint_id : r.blueprint_idx);
            if(!groups[k]) groups[k] = { sample:r, rows:[] };
            groups[k].rows.push(r);
        });

        const cardsHtml = Object.keys(groups).map(k => {
            const g = groups[k];
            const r = g.sample;
            const count = g.rows.length;
            const firstRowId = g.rows[0].row_id;
            const imgSrc = r.img ? (r.img.startsWith('http') ? r.img : (GITHUB_BASE + r.img)) : '';
            const ovrTxt = (r.category === 'futbolista') ? `OVR ${r.ovr}` :
                           (r.category === 'uniforme')   ? (r.tier || 'UNIFORM') :
                                                            ('+'+(r.bonus_pct||0)+'%');
            const safeName = (r.name||'').replace(/'/g,"\\'");
            return `
            <div class="admin-nft-card" id="admin-nft-card-${firstRowId}"
                 onclick="adminSelectNFT('${firstRowId}')"
                 style="border-color:${r.rarity_border};">
                <span class="admin-nft-checkmark">✓</span>
                <div style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.85);border:1px solid var(--gold);border-radius:6px;padding:2px 7px;font-size:0.55em;color:var(--gold);font-weight:800;z-index:3;font-family:'Orbitron',sans-serif">STOCK ×${count}</div>
                <img src="${imgSrc}" alt="${safeName}"
                     onerror="this.onerror=null;this.style.background='#0a130a';this.alt='${r.flag||'🎁'}';"
                     style="display:block;width:100%;aspect-ratio:3/4;object-fit:cover;">
                <div class="admin-nft-card-info">
                    <div class="admin-nft-card-name">${r.flag||''} ${r.name||''}</div>
                    <div class="admin-nft-card-ovr">${ovrTxt}</div>
                    <div class="admin-nft-card-rarity" style="color:${r.rarity_border.replace('rgba','rgb').replace(/,[\d.]+\)$/,')')};">${r.rarity}</div>
                </div>
            </div>`;
        }).join('');

        const totalAdminStock = inv.filter(r => r.owner_id === ADMIN_OWNER_ID).length;
        const stockBar = `<div style="margin-bottom:8px;padding:7px 10px;background:rgba(255,215,77,0.08);border:1px solid rgba(255,215,77,0.25);border-radius:8px;font-family:'Orbitron',sans-serif;font-size:0.62em;color:var(--gold);letter-spacing:2px;display:flex;justify-content:space-between;align-items:center;">
            <span>📦 STOCK TOTAL ADMIN</span>
            <span style="font-size:1.15em;font-weight:900;">${totalAdminStock}</span>
        </div>`;
        grid.innerHTML = stockBar + tabsHtml + cardsHtml;
    }

    window.adminGiftSwitchCategory = function(cat){
        _adminGiftCategory = cat;
        if(_adminGiftTargetWallet) adminRenderNFTInventory(_adminGiftTargetWallet);
    };

    // ── Select a specific admin-owned row by row_id ──────────────────────
    window.adminSelectNFT = function(rowId){
        const inv = _ensureAdminInventoryFresh();
        const row = inv.find(r => r.row_id === rowId && r.owner_id === ADMIN_OWNER_ID);
        if(!row) return;
        _adminGiftSelectedNFT = row;

        document.querySelectorAll('.admin-nft-card').forEach(c => c.classList.remove('selected'));
        const card = document.getElementById('admin-nft-card-'+rowId);
        if(card) card.classList.add('selected');

        const preview  = document.getElementById('admin-gift-preview');
        const prevImg  = document.getElementById('admin-gift-preview-img');
        const prevName = document.getElementById('admin-gift-preview-name');
        const prevAttr = document.getElementById('admin-gift-preview-attrs');
        const giftBtn  = document.getElementById('admin-do-gift-btn');
        const imgSrc   = row.img ? (row.img.startsWith('http') ? row.img : (GITHUB_BASE + row.img)) : '';

        if(preview)  preview.classList.add('visible');
        if(prevImg)  { prevImg.src = imgSrc; prevImg.onerror = function(){ this.onerror=null; this.style.background='#0a130a'; }; }
        if(prevName) prevName.textContent = (row.flag||'') + ' ' + row.name + ' · ' + row.category.toUpperCase();
        const attrs = [];
        if(row.category === 'futbolista') {
            attrs.push(`<span class="admin-gift-preview-attr">OVR ${row.ovr}</span>`);
            attrs.push(`<span class="admin-gift-preview-attr">💎 ${row.gem_min}–${row.gem_max}/día</span>`);
        }
        if(row.category === 'zapatilla' || row.category === 'entrenador') {
            attrs.push(`<span class="admin-gift-preview-attr">⚡ +${row.bonus_pct}%</span>`);
        }
        if(row.category === 'uniforme') {
            attrs.push(`<span class="admin-gift-preview-attr">${row.tier}</span>`);
            if(row.fisico) attrs.push(`<span class="admin-gift-preview-attr">💪 +${row.fisico} físico</span>`);
        }
        attrs.push(`<span class="admin-gift-preview-attr">${row.rarity}</span>`);
        attrs.push(`<span class="admin-gift-preview-attr">💪 Dur: ${row.durability}%</span>`);
        attrs.push(`<span class="admin-gift-preview-attr">⚽ PvP ✅ Torneo ✅ ($10 USDT fee)</span>`);
        if(prevAttr) prevAttr.innerHTML = attrs.join('');
        if(giftBtn && _adminGiftTargetWallet) giftBtn.disabled = false;
    };

    // ── Push a transferred row into the recipient's per-category inventory key ─
    function _applyGiftToRecipientLocal(pfx, row){
        try{
            if(row.category === 'futbolista'){
                const k = pfx + '_carros';
                let arr = []; try{ arr = JSON.parse(localStorage.getItem(k)||'[]'); }catch(e){}
                const ex = arr.find(e => e.idx === row.blueprint_idx);
                const prevQty = ex ? ex.qty : 0;
                if(ex){ ex.qty += 1; ex.isGift = true; } else { arr.push({ idx: row.blueprint_idx, qty: 1, isGift: true }); }
                localStorage.setItem(k, JSON.stringify(arr));
                // durability slot init
                const dk = pfx + '_durabilidades';
                let durObj = {}; try{ durObj = JSON.parse(localStorage.getItem(dk)||'{}'); }catch(e){}
                durObj[row.blueprint_idx + '_' + prevQty] = 100;
                localStorage.setItem(dk, JSON.stringify(durObj));
            } else if(row.category === 'zapatilla' || row.category === 'entrenador'){
                const k = pfx + '_inv_items';
                let obj = { tenis:{}, entrenador:{} };
                try{ obj = JSON.parse(localStorage.getItem(k)||'{"tenis":{},"entrenador":{}}'); }catch(e){}
                const kind = (row.category === 'zapatilla') ? 'tenis' : 'entrenador';
                if(!obj[kind]) obj[kind] = {};
                obj[kind][row.blueprint_idx] = (obj[kind][row.blueprint_idx] || 0) + 1;
                localStorage.setItem(k, JSON.stringify(obj));
            } else if(row.category === 'uniforme'){
                const k = pfx + '_inv_uniformes';
                let obj = {}; try{ obj = JSON.parse(localStorage.getItem(k)||'{}'); }catch(e){}
                obj[row.blueprint_id] = (obj[row.blueprint_id] || 0) + 1;
                localStorage.setItem(k, JSON.stringify(obj));
            }
        }catch(e){}
    }

    // If the gift goes to the currently logged-in user (same device), reflect
    // it immediately into the live in-memory state so the UI updates without reload.
    function _applyGiftToLiveStateIfCurrentUser(pfx, row){
        try{
            if(typeof _pfx !== 'function' || _pfx() !== pfx) return;
            if(row.category === 'futbolista' && typeof carrosComprados !== 'undefined'){
                const ex = carrosComprados.find(e => e.idx === row.blueprint_idx);
                if(ex){ ex.qty += 1; } else { carrosComprados.push({ idx: row.blueprint_idx, qty:1, isGift:true }); }
            } else if((row.category === 'zapatilla' || row.category === 'entrenador') && typeof _itemsComprados !== 'undefined'){
                const kind = (row.category === 'zapatilla') ? 'tenis' : 'entrenador';
                if(!_itemsComprados[kind]) _itemsComprados[kind] = {};
                _itemsComprados[kind][row.blueprint_idx] = (_itemsComprados[kind][row.blueprint_idx] || 0) + 1;
            } else if(row.category === 'uniforme' && typeof _uniformesComprados !== 'undefined'){
                _uniformesComprados[row.blueprint_id] = (_uniformesComprados[row.blueprint_id] || 0) + 1;
            }
            if(typeof saveState === 'function') saveState();
            if(typeof actualizarUI === 'function') actualizarUI();
            if(typeof buildGarageInventory === 'function') buildGarageInventory();
        }catch(e){}
    }

    // ── Execute the gift transfer (owner_id swap: Admin → recipient) ─────
    window.adminEjecutarGiftNFT = async function(){
        const giftBtn = document.getElementById('admin-do-gift-btn');
        const logEl   = document.getElementById('admin-gift-log');

        if(!_adminGiftTargetWallet){
            if(logEl) logEl.textContent = '❌ No hay wallet de destino. Busca un referido primero.';
            return;
        }
        if(!_adminGiftSelectedNFT){
            if(logEl) logEl.textContent = '❌ Selecciona un NFT para regalar.';
            return;
        }
        if(!_esAdmin()){
            if(logEl) logEl.textContent = '🔒 Solo el Administrador puede usar esta función.';
            return;
        }

        if(giftBtn) { giftBtn.disabled = true; const sp = giftBtn.querySelector('span'); if(sp) sp.textContent = '⏳ Transfiriendo…'; }
        if(logEl)   logEl.textContent = '⏳ Procesando transferencia interna…';

        try{
            const row = _adminGiftSelectedNFT;
            const inv = _ensureAdminInventoryFresh();
            const target = inv.find(r => r.row_id === row.row_id);
            if(!target) throw new Error('Fila no encontrada en el inventario');
            if(target.owner_id !== ADMIN_OWNER_ID) throw new Error('Esta unidad ya no pertenece al Admin');

            // ── owner_id swap: Admin → recipient ──────────────────────────
            target.owner_id          = _adminGiftTargetPfx || _adminGiftTargetWallet;
            target.owner_wallet      = _adminGiftTargetWallet;
            target.owner_pfx         = _adminGiftTargetPfx;
            target.gifted_at         = new Date().toISOString();
            target.gifted_by_admin   = true;
            target.is_gift           = true;
            // Mirror gameplay flags verbatim
            target.pvp_eligible        = true;
            target.tournament_eligible = true;
            target.tournament_fee_paid = false;
            _saveAdminInventory(inv);

                        nft_id:              target.blueprint_id,
                        nft_name:            target.name,
                        nft_img:             target.img,
                        category:            target.category,
                        ovr:                 target.ovr || null,
                        rarity:              target.rarity,
                        gem_min:             target.gem_min,
                        gem_max:             target.gem_max,
                        durability:          target.durability,
                        pvp_eligible:        true,
                        tournament_eligible: true,
                        tournament_fee_paid: false,
                        is_gift:             true,
                        gifted_by_admin:     true,
                        gifted_at:           target.gifted_at,
                        row_id:              target.row_id,
                    });
                }
            }catch(_e){ /* DB optional */ }

            const _tonOk = _isLikelyTonWalletAddress(target.owner_wallet);
            const _linkLabel = _tonOk ? '🔗 TON' : '🏦 Interna';
            if(logEl) logEl.innerHTML = `<span style="color:var(--green);">✅ "${target.name}" (${target.category}) transferido → ${_linkLabel} ${_adminGiftTargetWallet.slice(0,12)}...${_adminGiftTargetWallet.slice(-8)}</span>`;
            if(typeof mostrarMensaje === 'function') mostrarMensaje(`✅ Gift enviado: ${target.name} → ${_adminGiftTargetWallet.slice(0,8)}…`, '#00ff88');

            // Reset selection & re-render grid (stock count drops by 1)
            _adminGiftSelectedNFT = null;
            const preview = document.getElementById('admin-gift-preview');
            if(preview) preview.classList.remove('visible');
            adminRenderNFTInventory(_adminGiftTargetWallet);

        }catch(err){
            if(logEl) logEl.innerHTML = `<span style="color:var(--red);">❌ Error: ${err.message||'desconocido'}</span>`;
            if(typeof mostrarMensaje === 'function') mostrarMensaje('❌ Error al transferir NFT', '#ff4444');
        } finally {
            if(giftBtn) { giftBtn.disabled = false; const sp = giftBtn.querySelector('span'); if(sp) sp.textContent = 'Transferir NFT Internamente'; }
        }
    };

    // Pre-warm the seed once on load so the 100×N rows exist before the admin opens the panel.
    try{ _ensureAdminInventoryFresh(); }catch(e){}

    window.adminCopiarWalletGift = function(addr, btn){
        const ok = ()=>{
            if(btn){ const o=btn.innerHTML; btn.innerHTML='✅ Copiado'; setTimeout(()=>{btn.innerHTML=o;},1800); }
            if(typeof window.mostrarMensaje==='function') window.mostrarMensaje('📋 Dirección copiada','#42f58d');
        };
        try{
            if(navigator.clipboard && navigator.clipboard.writeText){
                navigator.clipboard.writeText(addr).then(ok).catch(()=>{
                    const ta=document.createElement('textarea');ta.value=addr;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();ok();
                });
            } else {
                const ta=document.createElement('textarea');ta.value=addr;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();ok();
            }
        }catch(e){}
    };

    // Hook buildReferidosUI para refrescar el panel cada vez que se abra
    function _hookBuild(){
        const orig = window.buildReferidosUI;
        if(typeof orig !== 'function') return false;
        if(orig.__giftHooked) return true;
        const wrapped = function(){
            const r = orig.apply(this, arguments);
            try{ _togglePanel(); }catch(e){}
            return r;
        };
        wrapped.__giftHooked = true;
        window.buildReferidosUI = wrapped;
        return true;
    }
    if(!_hookBuild()){
        let tries = 0;
        const iv = setInterval(()=>{ if(_hookBuild() || ++tries>40) clearInterval(iv); }, 250);
    }

    // Re-evaluar cuando cambie el estado de la wallet
    function _watchWallet(){
        try{
            if(window.tonConnectUI && typeof window.tonConnectUI.onStatusChange === 'function'){
                window.tonConnectUI.onStatusChange(()=>{ setTimeout(_togglePanel, 100); });
                return true;
            }
        }catch(e){}
        return false;
    }
    if(!_watchWallet()){
        let t = 0;
        const iv = setInterval(()=>{ if(_watchWallet() || ++t>40) clearInterval(iv); }, 300);
    }

    // Chequeo periódico de respaldo mientras el modal esté visible
    setInterval(()=>{
        const m = document.getElementById('modal-referidos');
        if(m && m.classList.contains('active')) _togglePanel();
    }, 1500);
})();



function apuestaCheckFecha() {
    const ahora = new Date();
    const bloqueado = ahora < FECHA_INICIO_MUNDIAL;
    const modal = document.getElementById('modal-apuesta');
    if (!modal) return;

    // Banner de cuenta regresiva
    let banner = document.getElementById('ap-mundial-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ap-mundial-banner';
        banner.style.cssText = `
            background:linear-gradient(135deg,rgba(255,140,0,0.15),rgba(255,68,68,0.1));
            border:1px solid rgba(255,140,0,0.5);border-radius:14px;padding:16px;
            text-align:center;margin-bottom:14px;
        `;
        const body = modal.querySelector('.modal-body');
        if (body) body.insertBefore(banner, body.firstChild);
    }

    if (bloqueado) {
        const diff = FECHA_INICIO_MUNDIAL - ahora;
        const totalSec = Math.floor(diff / 1000);
        const dias  = Math.floor(totalSec / 86400);
        const horas = Math.floor((totalSec % 86400) / 3600);
        const mins  = Math.floor((totalSec % 3600) / 60);
        const segs  = totalSec % 60;
        const pad = n => String(n).padStart(2,'0');
        banner.innerHTML = `
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4em;color:var(--orange);letter-spacing:4px;margin-bottom:6px;">
                ⚽ MUNDIAL CATAR 2026
            </div>
            <div style="font-size:0.8em;color:#aaa;margin-bottom:10px;">Las apuestas se habilitan el <strong style="color:var(--gold)">11 de Junio 2026</strong><br>con el inicio oficial de los partidos</div>
            <div style="display:flex;gap:8px;justify-content:center;margin-bottom:8px;">
                <div style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,140,0,0.4);border-radius:10px;padding:8px 12px;min-width:54px;text-align:center;">
                    <div style="font-family:'Orbitron',sans-serif;font-size:1.4em;font-weight:700;color:var(--orange);">${dias}</div>
                    <div style="font-size:0.58em;color:#888;text-transform:uppercase;letter-spacing:1px;">Días</div>
                </div>
                <div style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,140,0,0.4);border-radius:10px;padding:8px 12px;min-width:54px;text-align:center;">
                    <div style="font-family:'Orbitron',sans-serif;font-size:1.4em;font-weight:700;color:var(--orange);">${pad(horas)}</div>
                    <div style="font-size:0.58em;color:#888;text-transform:uppercase;letter-spacing:1px;">Horas</div>
                </div>
                <div style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,140,0,0.4);border-radius:10px;padding:8px 12px;min-width:54px;text-align:center;">
                    <div style="font-family:'Orbitron',sans-serif;font-size:1.4em;font-weight:700;color:var(--orange);">${pad(mins)}</div>
                    <div style="font-size:0.58em;color:#888;text-transform:uppercase;letter-spacing:1px;">Min</div>
                </div>
                <div style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,140,0,0.4);border-radius:10px;padding:8px 12px;min-width:54px;text-align:center;">
                    <div style="font-family:'Orbitron',sans-serif;font-size:1.4em;font-weight:700;color:var(--orange);">${pad(segs)}</div>
                    <div style="font-size:0.58em;color:#888;text-transform:uppercase;letter-spacing:1px;">Seg</div>
                </div>
            </div>
            <div style="font-size:0.75em;color:#666;">🔒 Las apuestas estarán disponibles cuando comience el Mundial</div>
        `;

        // Deshabilitar tabs y botones de apuestas
        const tabPartidos   = document.getElementById('ap-tab-partidos');
        const tabMistickets = document.getElementById('ap-tab-mistickets');
        if (tabPartidos) tabPartidos.innerHTML = `
            <div style="text-align:center;padding:30px 0;">
                <div style="font-size:2.5em;margin-bottom:10px;">🔒</div>
                <div style="font-family:'Orbitron',sans-serif;font-size:0.82em;color:#888;letter-spacing:2px;">DISPONIBLE EL 11/06/2026</div>
                <div style="font-size:0.8em;color:#555;margin-top:8px;">Espera el inicio del Mundial para apostar</div>
            </div>`;
    } else {
        banner.innerHTML = `
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.3em;color:var(--green);letter-spacing:3px;margin-bottom:4px;">
                ✅ ¡MUNDIAL EN CURSO!
            </div>
            <div style="font-size:0.82em;color:#aaa;">Las apuestas están <strong style="color:var(--green)">habilitadas</strong>. ¡Buena suerte! 🏆</div>
        `;
    }
}

// Actualizar cuenta regresiva cada segundo cuando el modal esté abierto
setInterval(() => {
    const modal = document.getElementById('modal-apuesta');
    if (modal && modal.classList.contains('active')) {
        apuestaCheckFecha();
    }
}, 1000);

// ═══════════════════════════════════════════════════════════════
//  TORNEO — SISTEMA DE REGISTRO DE WALLET + PAGO USDT
// ═══════════════════════════════════════════════════════════════
var TORNEO_REGISTRO_KEY = 'futmundi_torneo_registros_v2';
var TORNEO_COSTO_USDT   = 10;

// ── TORNEO: CONTADOR DE USUARIOS CON NFT Y SYNC DESDE SUPABASE ──────────
window.torneoNFTUsersCount = 0;

async function torneoActualizarContadorUsuariosNFT() {
    try {
        const sb = (typeof _supa === 'function') ? _supa() : null;
        if (!sb) return;

        // 1. Sincronizar participantes registrados desde Supabase
        const { data: listData, error: listError } = await sb
            .from('tournament_registrations')
            .select('*');
        if (!listError && listData) {
            const synced = listData.map(r => ({
                wallet: r.wallet,
                alias: r.alias || 'Jugador',
                fecha: r.registered_at || new Date().toISOString(),
                pagado: r.tournament_fee_paid,
                tournament_fee_paid: r.tournament_fee_paid,
                fee_amount_usdt: r.fee_amount_usdt,
                nft_idx: r.nft_idx,
                nft_copy: r.nft_copy
            }));
            torneoSaveRegistros(synced);
        }

        // 2. Contar usuarios con NFT de la tabla referrals_map (usuarios totales con NFT)
        const { count, error } = await sb
            .from('referrals_map')
            .select('*', { count: 'exact', head: true });
        if (!error && count !== null) {
            window.torneoNFTUsersCount = count;
            const counterEl = document.getElementById('tor-nft-users-counter');
            if (counterEl) {
                counterEl.textContent = `${window.torneoNFTUsersCount} / 100`;
            }
            const btnPago = document.getElementById('tor-btn-pago');
            if (btnPago) {
                if (window.torneoNFTUsersCount >= 100) {
                    btnPago.disabled = false;
                    btnPago.style.opacity = '1';
                    btnPago.style.cursor = 'pointer';
                    btnPago.innerHTML = '💳 Pagar e Inscribirse';
                } else {
                    btnPago.disabled = true;
                    btnPago.style.opacity = '0.5';
                    btnPago.style.cursor = 'not-allowed';
                    btnPago.innerHTML = `🔒 Habilitado con 100 usuarios con NFT (${window.torneoNFTUsersCount}/100)`;
                }
            }
        }
    } catch (e) {
        console.warn('[torneo] Error updating tournament sync:', e);
    }
}
window.torneoActualizarContadorUsuariosNFT = torneoActualizarContadorUsuariosNFT;


function torneoGetRegistros() {
    try { return JSON.parse(localStorage.getItem(TORNEO_REGISTRO_KEY) || '[]'); } catch(e){ return []; }
}
function torneoSaveRegistros(arr) {
    localStorage.setItem(TORNEO_REGISTRO_KEY, JSON.stringify(arr));
}
function torneoEstaRegistrado(walletAddr) {
    if (!walletAddr) return false;
    return torneoGetRegistros().some(r => r.wallet === walletAddr);
}
function torneoRegistrar(walletAddr, alias, nftIdx, nftCopy) {
    const registros = torneoGetRegistros();
    if (torneoEstaRegistrado(walletAddr)) return false;
    // ── SERVER-SIDE GATE (client mirror): valida fee pagado ────────────────
    // El registro solo se completa si tournament_fee_paid === true.
    // La verificación real ocurre en el bloque onConfirmar() de abrirPagoQR;
    // este flag se setea SOLO después de que tonConnect confirma la tx.
    const row = {
        wallet:               walletAddr,
        alias:                alias || 'Jugador #' + (registros.length + 1),
        fecha:                new Date().toISOString(),
        pagado:               true,
        tournament_fee_paid:  true,   // gate flag — MUST be true to play
        monto:                TORNEO_COSTO_USDT,
        nft_idx:              nftIdx !== undefined ? nftIdx : null,
        nft_copy:             nftCopy !== undefined ? nftCopy : 0,
        nft_locked:           false,  // set true if item disabled for tournament
    };
    registros.push(row);
    torneoSaveRegistros(registros);
    return true;
}

// ── VALIDATE TOURNAMENT ACCESS (gate: $10 fee required) ────────────────────
// Called before any tournament match; returns { allowed, reason }
function torneoValidarAcceso(walletAddr, nftIdx) {
    if (!walletAddr) return { allowed: false, reason: '🔗 Wallet no conectada. Conecta tu wallet TON.' };
    const reg = torneoGetRegistros().find(r => r.wallet === walletAddr);
    if (!reg)                         return { allowed: false, reason: '💳 No inscrito. Paga los $10 USDT de inscripción para acceder.' };
    if (!reg.tournament_fee_paid)     return { allowed: false, reason: '🔒 Pago de inscripción ($10 USDT) no confirmado. Completa el pago para desbloquear el Torneo.' };
    if (nftIdx !== undefined && nftIdx !== null) {
        const dur = (typeof getDurabilidad === 'function') ? getDurabilidad(nftIdx, reg.nft_copy || 0) : 100;
        if (dur <= 0) return { allowed: false, reason: '🏋️ Durabilidad 0%. Repara este NFT en el Área de Entrenamiento antes de competir.' };
    }
    return { allowed: true, reason: '✅ Acceso al torneo confirmado.' };
}
window.torneoValidarAcceso = torneoValidarAcceso;

function torneoTabSwitch(tab) {
    ['info','registro','inscritos'].forEach(t => {
        const el = document.getElementById('tor-tab-' + t);
        const btn = document.getElementById('tor-tab-btn-' + t);
        if (el)  el.style.display = t === tab ? '' : 'none';
        if (btn) btn.classList.toggle('active', t === tab);
    });
    if (tab === 'registro')  torneoRenderRegistro();
    if (tab === 'inscritos') torneoRenderInscritos();

    if (typeof torneoActualizarContadorUsuariosNFT === 'function') {
        torneoActualizarContadorUsuariosNFT();
    }
}

function torneoRenderRegistro() {
    const el = document.getElementById('tor-registro-content');
    if (!el) return;

    const walletAddr = (typeof _walletAddr === 'function') ? _walletAddr() : null;
    const yaRegistrado = torneoEstaRegistrado(walletAddr);
    const conectado = !!walletAddr;

    if (yaRegistrado) {
        const reg = torneoGetRegistros().find(r => r.wallet === walletAddr);
        const fecha = reg ? new Date(reg.fecha).toLocaleDateString('es', {day:'2-digit',month:'short',year:'numeric'}) : '—';
        const nftName = (reg && reg.nft_idx !== null && typeof PLAYERS !== 'undefined') ? (PLAYERS[reg.nft_idx]?.nombre || 'NFT #'+reg.nft_idx) : '—';
        el.innerHTML = `
            <div style="text-align:center;padding:20px 0;">
                <div style="font-size:3em;margin-bottom:10px;">✅</div>
                <div style="font-family:'Orbitron',sans-serif;font-size:0.9em;color:var(--green);letter-spacing:2px;margin-bottom:6px;">¡YA ESTÁS INSCRITO!</div>
                <div style="font-size:0.82em;color:#aaa;margin-bottom:14px;">Tu wallet fue registrada el <strong style="color:var(--gold)">${fecha}</strong></div>
                <div style="background:rgba(0,255,136,0.08);border:1px solid rgba(0,255,136,0.3);border-radius:12px;padding:14px;text-align:left;margin-bottom:10px;">
                    <div style="font-size:0.72em;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">🔑 Tu Wallet Registrada</div>
                    <div style="font-family:'Orbitron',sans-serif;font-size:0.72em;color:var(--cyan);word-break:break-all;">${walletAddr}</div>
                </div>
                ${nftName !== '—' ? `<div style="background:rgba(255,215,0,0.07);border:1px solid rgba(255,215,0,0.25);border-radius:10px;padding:10px 14px;text-align:left;margin-bottom:10px;"><div style="font-size:0.68em;color:#888;margin-bottom:4px;">🎮 NFT SELECCIONADO</div><div style="font-family:'Orbitron',sans-serif;font-size:0.76em;color:var(--gold);">${nftName}</div></div>` : ''}
                <div style="font-size:0.8em;color:#666;">Pago de <strong style="color:var(--gold)">$${TORNEO_COSTO_USDT} USDT</strong> confirmado · Partida el próximo Lunes 00:00 UTC</div>
            </div>`;
        return;
    }

    if (!conectado) {
        el.innerHTML = `
            <div style="text-align:center;padding:20px 0;">
                <div style="font-size:2.5em;margin-bottom:10px;">🔗</div>
                <div style="font-family:'Orbitron',sans-serif;font-size:0.78em;color:var(--orange);letter-spacing:2px;margin-bottom:10px;">CONECTA TU WALLET</div>
                <div style="font-size:0.84em;color:#aaa;margin-bottom:16px;line-height:1.6;">Para inscribirte al torneo necesitas conectar tu wallet TON.<br>El pago de inscripción se enviará desde tu wallet.</div>
                <div style="background:rgba(255,140,0,0.08);border:1px solid rgba(255,140,0,0.3);border-radius:12px;padding:14px;font-size:0.82em;color:#ffd9a8;margin-bottom:16px;">
                    ⚠️ Conecta tu wallet TON usando el botón en la barra superior antes de continuar.
                </div>
                <button onclick="torneoRenderRegistro()" style="padding:10px 24px;background:rgba(0,212,255,0.15);border:1px solid var(--cyan);border-radius:10px;color:var(--cyan);font-family:'Orbitron',sans-serif;font-weight:700;font-size:0.78em;letter-spacing:2px;cursor:pointer;text-transform:uppercase;">
                    🔄 Verificar Conexión
                </button>
            </div>`;
        return;
    }

    const registros = torneoGetRegistros();
    const numInscritos = registros.length;

    el.innerHTML = `
        <div style="background:linear-gradient(135deg,rgba(255,215,0,0.1),rgba(255,140,0,0.08));border:1px solid rgba(255,215,0,0.35);border-radius:14px;padding:16px;margin-bottom:14px;text-align:center;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4em;color:var(--gold);letter-spacing:4px;margin-bottom:4px;">INSCRIPCIÓN AL TORNEO</div>
            <div style="font-size:0.82em;color:#aaa;">Gran Copa FUTMUNDI · Torneo Semanal</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
            <div style="background:rgba(0,255,136,0.07);border:1px solid rgba(0,255,136,0.25);border-radius:10px;padding:12px;text-align:center;">
                <div style="font-size:0.68em;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">💳 Costo</div>
                <div style="font-family:'Orbitron',sans-serif;font-weight:900;color:var(--gold);font-size:1.2em;">$${TORNEO_COSTO_USDT} USDT</div>
            </div>
            <div style="background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.25);border-radius:10px;padding:12px;text-align:center;">
                <div style="font-size:0.68em;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">👥 Inscritos</div>
                <div style="font-family:'Orbitron',sans-serif;font-weight:700;color:var(--cyan);font-size:1.2em;">${numInscritos}</div>
            </div>
        </div>

        <div style="margin-bottom:14px;">
            <label style="font-size:0.78em;color:#888;text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:6px;">👤 Tu Alias (opcional)</label>
            <input id="tor-alias-input" type="text" maxlength="20" placeholder="Ej: Messi10, Jugador Estrella..."
                style="width:100%;padding:10px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(0,212,255,0.3);border-radius:10px;color:#fff;font-family:'Fredoka',sans-serif;font-size:0.92em;outline:none;transition:border-color 0.2s;"
                onfocus="this.style.borderColor='var(--cyan)'" onblur="this.style.borderColor='rgba(0,212,255,0.3)'">
        </div>

        <div class="torneo-nft-picker">
            <span class="torneo-nft-picker-label">🎮 Selecciona tu NFT para el Torneo</span>
            <select id="tor-nft-select" style="width:100%;padding:10px 14px;background:rgba(0,0,0,0.55);border:1px solid rgba(0,212,255,0.3);border-radius:10px;color:#fff;font-family:'Fredoka',sans-serif;font-size:0.92em;outline:none;cursor:pointer;">
                <option value="">— Elige tu Futbolista NFT —</option>
            </select>
            <div id="tor-nft-durability-warn" style="display:none;margin-top:6px;padding:8px 12px;background:rgba(255,90,111,0.1);border:1px solid rgba(255,90,111,0.4);border-radius:8px;font-size:0.78em;color:var(--red);line-height:1.5;">
                ⚠️ La durabilidad de este NFT es baja (&lt;30%). Considera repararlo en el <strong>Área de Entrenamiento</strong> para óptimo rendimiento.
            </div>
        </div>

        <div style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);border-radius:10px;padding:12px;margin-bottom:14px;font-size:0.8em;color:#aaa;">
            <div style="margin-bottom:6px;color:var(--cyan);font-family:'Orbitron',sans-serif;font-size:0.78em;letter-spacing:1px;">🔑 WALLET CONECTADA</div>
            <div style="font-family:'Orbitron',sans-serif;font-size:0.7em;word-break:break-all;color:#bbb;">${walletAddr}</div>
        </div>

        <div style="background:rgba(255,215,0,0.06);border:1px solid rgba(255,215,0,0.2);border-radius:10px;padding:12px;margin-bottom:14px;font-size:0.8em;color:#aaa;display:flex;justify-content:space-between;align-items:center;">
            <div>
                <div style="margin-bottom:4px;color:var(--gold);font-family:'Orbitron',sans-serif;font-size:0.78em;letter-spacing:1px;">👥 USUARIOS CON NFT</div>
                <div style="font-size:0.72em;color:#aaa;">Se requieren 100 usuarios para habilitar el pago</div>
            </div>
            <div style="font-family:'Orbitron',sans-serif;font-weight:900;color:var(--gold);font-size:1.3em;" id="tor-nft-users-counter">
                ${window.torneoNFTUsersCount || 0} / 100
            </div>
        </div>

        <div style="background:rgba(255,140,0,0.08);border:1px solid rgba(255,140,0,0.3);border-radius:10px;padding:12px;margin-bottom:16px;font-size:0.8em;color:#ffd9a8;line-height:1.6;">
            💡 Al confirmar, se procesará el pago de <strong style="color:var(--gold)">$${TORNEO_COSTO_USDT} USDT</strong> desde tu wallet TON al contrato inteligente FUTMUNDI. Tu wallet quedará registrada en el torneo.
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button onclick="torneoTabSwitch('info')"
                style="padding:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#888;font-family:'Fredoka',sans-serif;font-weight:700;font-size:0.85em;cursor:pointer;">
                ← Volver
            </button>
            <button id="tor-btn-pago" onclick="torneoProcesarPago()"
                ${(window.torneoNFTUsersCount || 0) < 100 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}
                style="padding:12px;background:linear-gradient(135deg,rgba(255,215,0,0.2),rgba(255,140,0,0.18));border:1px solid var(--gold);border-radius:10px;color:var(--gold);font-family:'Orbitron',sans-serif;font-weight:700;font-size:0.78em;letter-spacing:1px;cursor:pointer;transition:all 0.2s;text-transform:uppercase;">
                ${(window.torneoNFTUsersCount || 0) >= 100 ? '💳 Pagar e Inscribirse' : `🔒 Habilitado con 100 usuarios con NFT (${window.torneoNFTUsersCount || 0}/100)`}
            </button>
        </div>`;

    // ── Populate NFT dropdown ──────────────────────────────────────────────
    (function _populateTorneoNFTSelect(){
        const sel  = document.getElementById('tor-nft-select');
        const warn = document.getElementById('tor-nft-durability-warn');
        if (!sel) return;

        // Build options from carrosComprados
        const items = (typeof carrosComprados !== 'undefined') ? carrosComprados : [];
        sel.innerHTML = '<option value="">— Elige tu Futbolista NFT —</option>';

        if (!items.length) {
            sel.innerHTML += '<option value="" disabled>⚠️ No tienes futbolistas NFT</option>';
            return;
        }
        items.forEach(entry => {
            for (let copy = 0; copy < entry.qty; copy++) {
                const player = (typeof PLAYERS !== 'undefined') ? PLAYERS[entry.idx] : null;
                if (!player) continue;
                const dur    = (typeof getDurabilidad === 'function') ? getDurabilidad(entry.idx, copy) : 100;
                const durStr = dur < 30 ? ` ⚠️${dur}%` : ``;
                const qty    = entry.qty > 1 ? ` #${copy+1}` : '';
                const label  = `${player.flag} ${player.nombre}${qty} · OVR ${player.hp} · 💎${player.gemMin}–${player.gemMax}/día${durStr}`;
                const opt    = document.createElement('option');
                opt.value    = `${entry.idx}_${copy}`;
                opt.textContent = label;
                if (dur <= 0) {
                    opt.disabled    = true;
                    opt.textContent += ' [Reparar primero]';
                }
                sel.appendChild(opt);
            }
        });

        // Show durability warning on change
        sel.onchange = function() {
            if (!warn) return;
            const parts = (this.value||'').split('_');
            if (!parts[0]) { warn.style.display='none'; return; }
            const idx  = parseInt(parts[0],10);
            const copy = parseInt(parts[1]||'0',10);
            const dur  = (typeof getDurabilidad === 'function') ? getDurabilidad(idx,copy) : 100;
            warn.style.display = dur < 30 ? 'block' : 'none';
        };
    })();
}

function torneoRenderInscritos() {
    const lista = document.getElementById('tor-inscritos-lista');
    const count = document.getElementById('tor-inscritos-count');
    const registros = torneoGetRegistros();

    if (!lista) return;

    if (registros.length === 0) {
        lista.innerHTML = `<div style="text-align:center;padding:30px 0;color:#555;">
            <div style="font-size:2em;margin-bottom:8px;">🏟️</div>
            <div style="font-size:0.85em;">Aún no hay inscripciones confirmadas</div>
        </div>`;
        if (count) count.textContent = '0 participantes registrados';
        return;
    }

    lista.innerHTML = registros.map((r, i) => {
        const fecha = new Date(r.fecha).toLocaleDateString('es', {day:'2-digit',month:'short',year:'numeric'});
        const walletShort = r.wallet ? r.wallet.slice(0,8)+'...'+r.wallet.slice(-6) : '—';
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
        return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(45,122,31,0.2);border-radius:10px;">
            <div style="font-size:1.3em;flex-shrink:0;">${medal}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:0.88em;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.alias || 'Jugador #'+(i+1)}</div>
                <div style="font-family:'Orbitron',sans-serif;font-size:0.62em;color:var(--cyan);margin-top:2px;">${walletShort}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
                <div style="font-size:0.7em;color:var(--green);font-weight:700;">✅ $${r.monto} USDT</div>
                <div style="font-size:0.62em;color:#555;margin-top:2px;">${fecha}</div>
            </div>
        </div>`;
    }).join('');

    if (count) count.textContent = `${registros.length} participante${registros.length !== 1 ? 's' : ''} registrado${registros.length !== 1 ? 's' : ''}`;
}

async function torneoProcesarPago() {
    const walletAddr = (typeof _walletAddr === 'function') ? _walletAddr() : null;
    if (!walletAddr) {
        if (typeof mostrarMensaje === 'function') mostrarMensaje('⚠️ Conecta tu wallet primero', '#ffaa00');
        return;
    }
    if (torneoEstaRegistrado(walletAddr)) {
        if (typeof mostrarMensaje === 'function') mostrarMensaje('✅ Ya estás inscrito en este torneo', '#00ff88');
        torneoRenderRegistro();
        return;
    }

    const alias      = (document.getElementById('tor-alias-input')  || {}).value || '';
    const nftSelect  = document.getElementById('tor-nft-select');
    const nftVal     = nftSelect ? nftSelect.value : '';
    let   nftIdx     = null;
    let   nftCopy    = 0;

    // Parse "idx_copy" value from the select element
    if (nftVal && nftVal !== '') {
        const parts = nftVal.split('_');
        nftIdx  = parseInt(parts[0], 10);
        nftCopy = parseInt(parts[1] || '0', 10);
    }

    // ── GATE: validate NFT durability if item selected ────────────────────
    if (nftIdx !== null) {
        const dur = (typeof getDurabilidad === 'function') ? getDurabilidad(nftIdx, nftCopy) : 100;
        if (dur <= 0) {
            if (typeof mostrarMensaje === 'function') mostrarMensaje('🏋️ Durabilidad 0% — repara en el Área de Entrenamiento primero', '#ff4444');
            return;
        }
    }

    const btn = document.querySelector('#tor-registro-content button[onclick="torneoProcesarPago()"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Procesando…'; }

    try {
        if (typeof abrirPagoQR === 'function') {
            abrirPagoQR({
                tipo: 'torneo',
                titulo: '🏆 Inscripción al Torneo',
                descripcion: `Inscripción al torneo FUTMUNDI. El pago va al contrato inteligente. Cuota obligatoria: $${TORNEO_COSTO_USDT} USDT.`,
                usdt: TORNEO_COSTO_USDT,
                onConfirmar: async () => {
                    if (typeof isWalletConnected === 'function' && !isWalletConnected()) {
                        if (typeof mostrarMensaje === 'function') mostrarMensaje('⚠️ Conecta tu wallet', '#ffaa00');
                        return false;
                    }
                    if (typeof mostrarMensaje === 'function') mostrarMensaje(`⏳ Procesando $${TORNEO_COSTO_USDT} USDT…`, '#00d4ff');
                    try {
                        if (typeof buildContractTx === 'function' && typeof tonConnectUI !== 'undefined') {
                            const tx = await buildContractTx('torneo', TORNEO_COSTO_USDT);
                            await tonConnectUI.sendTransaction(tx);
                        }
                        // ── Register with tournament_fee_paid = true + selected NFT ──
                        torneoRegistrar(walletAddr, alias || null, nftIdx, nftCopy);

                        // ── Sync to Supabase (fire-and-forget) ────────────────────
                        try {
                            const sb = (typeof _supa === 'function') ? _supa() : null;
                            if (sb) {
                                await sb.from('tournament_registrations').upsert({
                                    wallet:              walletAddr,
                                    alias:               alias || null,
                                    nft_idx:             nftIdx,
                                    nft_copy:            nftCopy,
                                    tournament_fee_paid: true,
                                    fee_amount_usdt:     TORNEO_COSTO_USDT,
                                    registered_at:       new Date().toISOString()
                                }, { onConflict: 'wallet' });
                            }
                        } catch(dbErr){ console.warn('[torneo] DB sync failed:', dbErr); }

                        if (typeof mostrarMensaje === 'function') mostrarMensaje('✅ ¡Inscripción confirmada! $10 USDT pagados.', '#00ff88');
                        torneoRenderRegistro();
                        return true;
                    } catch(e) {
                        // ── GATE: if payment fails, tournament_fee_paid stays false ──
                        if (typeof mostrarMensaje === 'function') mostrarMensaje('❌ Pago cancelado — sin pago no hay acceso al Torneo', '#ff4444');
                        return false;
                    }
                }
            });
        } else {
            // Fallback: registrar directamente (demo sin TonConnect)
            torneoRegistrar(walletAddr, alias || null, nftIdx, nftCopy);
            if (typeof mostrarMensaje === 'function') mostrarMensaje('✅ ¡Inscripción registrada!', '#00ff88');
            torneoRenderRegistro();
        }
    } catch(e) {
        if (typeof mostrarMensaje === 'function') mostrarMensaje('❌ Error al procesar', '#ff4444');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '💳 Pagar e Inscribirse'; }
    }
}
// ════════════════════════════════════════════════════════════════
// Init: mostrar ícono de candado en botón apuesta si aún no abrió
(function() {
    function initApuestaBadge() {
        const ahora = new Date();
        const badge = document.getElementById('apuesta-lock-badge');
        if (badge && ahora < new Date('2026-06-11T00:00:00Z')) {
            badge.style.display = 'inline';
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initApuestaBadge);
    } else {
        initApuestaBadge();
    }
})();
// ════════════════════════════════════════════════════════════════
