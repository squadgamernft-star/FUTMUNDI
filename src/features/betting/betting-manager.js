// betting-manager.js - Sistema de apuestas 1X2 para el Mundial

export class BettingManager {
    constructor(supabase) {
        this.supabase = supabase;
        this.activeBets = [];
        this.partidos = [];
        this.currentMatch = null;
        this.selectedPick = null;
        this.amount = 0;
    }

    async loadPartidos() {
        try {
            const { data, error } = await this.supabase
                .from('worldcup_matches')
                .select('*')
                .gte('match_time', new Date().toISOString())
                .order('match_time', { ascending: true });

            if (error) throw error;
            this.partidos = data || [];
            return this.partidos;
        } catch (e) {
            console.error('[Betting] Error loading matches:', e);
            return [];
        }
    }

    async loadActiveBets(userPfx) {
        try {
            const { data, error } = await this.supabase
                .from('user_bets')
                .select('*')
                .eq('user_pfx', userPfx)
                .order('created_at', { ascending: false });

            if (error) throw error;
            this.activeBets = data || [];
            return this.activeBets;
        } catch (e) {
            console.error('[Betting] Error loading bets:', e);
            return [];
        }
    }

    async placeBet(matchId, pick, amountUsdt, userPfx, walletAddr) {
        if (amountUsdt < 1) {
            throw new Error('Monto mínimo: 1 USDT');
        }
        if (amountUsdt > 100) {
            throw new Error('Monto máximo: 100 USDT por apuesta');
        }

        const match = this.partidos.find(m => m.id === matchId);
        if (!match) throw new Error('Partido no encontrado');

        let odds = 0;
        if (pick === 'local') odds = match.odds_local;
        else if (pick === 'empate') odds = match.odds_draw;
        else if (pick === 'visita') odds = match.odds_away;
        else throw new Error('Selección inválida');

        const potentialWin = amountUsdt * odds;

        const { data, error } = await this.supabase
            .from('user_bets')
            .insert({
                match_id: matchId,
                user_pfx: userPfx,
                wallet_address: walletAddr,
                pick: pick,
                amount_usdt: amountUsdt,
                odds: odds,
                potential_win: potentialWin,
                status: 'pending',
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (error) throw error;

        // Actualizar estado local
        this.activeBets.unshift(data);
        return data;
    }

    async settleMatch(matchId, result) {
        // result: 'local', 'draw', 'away'
        const { data: bets, error } = await this.supabase
            .from('user_bets')
            .select('*')
            .eq('match_id', matchId)
            .eq('status', 'pending');

        if (error) throw error;

        for (const bet of bets) {
            const won = (bet.pick === result);
            const newStatus = won ? 'won' : 'lost';

            const { error: updateError } = await this.supabase
                .from('user_bets')
                .update({ status: newStatus, settled_at: new Date().toISOString() })
                .eq('id', bet.id);

            if (updateError) console.error('[Betting] Error settling bet:', updateError);
        }

        // Actualizar tabla de partidos con resultado
        await this.supabase
            .from('worldcup_matches')
            .update({ result: result, settled: true })
            .eq('id', matchId);

        return true;
    }

    async claimWinnings(betId, userPfx) {
        const { data: bet, error } = await this.supabase
            .from('user_bets')
            .select('*')
            .eq('id', betId)
            .eq('user_pfx', userPfx)
            .single();

        if (error) throw error;
        if (bet.status !== 'won') throw new Error('Esta apuesta no se puede reclamar');
        if (bet.claimed) throw new Error('Ya reclamaste estas ganancias');

        const { error: updateError } = await this.supabase
            .from('user_bets')
            .update({ claimed: true, claimed_at: new Date().toISOString() })
            .eq('id', betId);

        if (updateError) throw updateError;

        return { amount: bet.potential_win, bet: bet };
    }
}
