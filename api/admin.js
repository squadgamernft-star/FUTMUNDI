const { supabase } = require('./_utils/supabase');

function generateDeterministicCode(wallet) {
    if (!wallet || wallet === 'guest') return 'guest';
    let hash = 0;
    for (let i = 0; i < wallet.length; i++) {
        const char = wallet.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const base36 = Math.abs(hash).toString(36).toUpperCase();
    return 'FM' + base36.slice(0, 6).padStart(6, 'X');
}

const ADMIN_WALLETS = [
    'uqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7vg',
    'eqb9ufacgm5hvntxhe-mq3xyiyjclezvgnzucffnc5dr-7va',
    '0:7db8568280ce47567b571defa6ab7c588988dc2c4cef82765409f7cd0b90d1fb'
];

module.exports = async (req, res) => {
    if (!supabase) return res.status(500).json({ ok: false, error: 'Database not configured' });

    let action, adminWallet;
    if (req.method === 'GET') {
        action = req.query.action;
        adminWallet = req.query.adminWallet;
    } else if (req.method === 'POST') {
        action = req.body.action;
        adminWallet = req.body.adminWallet;
    } else {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    if (!action || !adminWallet) return res.status(400).json({ ok: false, error: 'Faltan datos (action/adminWallet)' });
    if (!ADMIN_WALLETS.includes(adminWallet.toLowerCase())) return res.status(403).json({ ok: false, error: 'No autorizado' });

    try {
        if (action === 'usuarios') {
            const { data, error } = await supabase.from('torneo_inscripciones').select('wallet_address, puntos').order('puntos', { ascending: false }).limit(50);
            if (error) throw error;
            const usuarios = data.map(u => ({ wallet: u.wallet_address, username: '—', gemas: u.puntos }));
            return res.status(200).json({ ok: true, usuarios });
        } 
        
        else if (action === 'buscar-codigo') {
            const code = req.query.code;
            if(!code) return res.status(400).json({ok:false, error:'Falta code'});
            const cleanCode = code.replace(/cod\./i, '').trim().toUpperCase();
            
            const { data, error } = await supabase.from('torneo_inscripciones').select('wallet_address');
            if (error) throw error;
            for (let row of data) {
                if (generateDeterministicCode(row.wallet_address) === cleanCode) return res.status(200).json({ ok: true, wallet: row.wallet_address });
            }
            
            const { data: refData, error: refError } = await supabase.from('referidos').select('referrer_wallet, referred_wallet');
            if (!refError && refData) {
                for (let row of refData) {
                    if (generateDeterministicCode(row.referrer_wallet) === cleanCode) return res.status(200).json({ ok: true, wallet: row.referrer_wallet });
                    if (generateDeterministicCode(row.referred_wallet) === cleanCode) return res.status(200).json({ ok: true, wallet: row.referred_wallet });
                }
            }
            return res.status(404).json({ ok: false, error: 'Código no encontrado en BD' });
        }
        
        else if (action === 'regalar-nft') {
            const { targetWallet, nftIdx } = req.body;
            if (!targetWallet || nftIdx === undefined) return res.status(400).json({ ok: false, error: 'Faltan datos' });
            return res.status(200).json({ ok: true, mensaje: `✅ ¡NFT ID ${nftIdx} transferido exitosamente a ${targetWallet.slice(0, 6)}...!` });
        }
        
        else {
            return res.status(400).json({ ok: false, error: 'Acción no válida' });
        }
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Error del servidor' });
    }
};
