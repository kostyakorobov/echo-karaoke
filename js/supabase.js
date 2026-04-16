import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, ROOM_ID } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const cmdChannel = sb.channel(`room_commands_${ROOM_ID}`);

export async function getSongById(songId) {
    const { data } = await sb.from('karaoke_songs').select('*').eq('id', songId).single();
    return data;
}

export async function getSongMeta(songId) {
    const { data } = await sb.from('karaoke_songs').select('title, artist').eq('id', songId).single();
    return data;
}

export async function getFirstSong() {
    const { data } = await sb.from('karaoke_songs').select('*').limit(1);
    return data?.[0] || null;
}

export async function getNextWaiting() {
    const { data } = await sb.from('karaoke_queue')
        .select('*, karaoke_songs(title, artist)')
        .eq('room_id', ROOM_ID)
        .eq('status', 'waiting')
        .order('position', { ascending: true })
        .limit(1);
    return data?.[0] || null;
}

export async function getQueueWaiting(limit = 5) {
    const { data } = await sb.from('karaoke_queue')
        .select('*, karaoke_songs(title, artist)')
        .eq('room_id', ROOM_ID)
        .eq('status', 'waiting')
        .order('position', { ascending: true })
        .limit(limit);
    return data || [];
}

export async function getCurrentPlaying() {
    const { data } = await sb.from('karaoke_queue')
        .select('id')
        .eq('room_id', ROOM_ID)
        .eq('status', 'playing')
        .limit(1);
    return data?.[0] || null;
}

export async function getLastDone() {
    const { data } = await sb.from('karaoke_queue')
        .select('*, karaoke_songs(title, artist)')
        .eq('room_id', ROOM_ID)
        .eq('status', 'done')
        .order('position', { ascending: false })
        .limit(1);
    return data?.[0] || null;
}

export async function setQueueStatus(id, status) {
    await sb.from('karaoke_queue').update({ status }).eq('id', id);
}

export function broadcastState(state) {
    cmdChannel.send({
        type: 'broadcast',
        event: 'player_state',
        payload: { state }
    });
}

export async function getAllSongs() {
    const { data } = await sb.from('karaoke_songs')
        .select('id, title, artist')
        .order('artist', { ascending: true });
    return data || [];
}

export async function searchSongsDB(query) {
    const q = query.replace(/[%_\\]/g, '\\$&');
    const { data } = await sb.from('karaoke_songs')
        .select('id, title, artist')
        .or(`title.ilike.%${q}%,artist.ilike.%${q}%`)
        .order('artist', { ascending: true })
        .limit(20);
    return data || [];
}

export async function addSongToQueue(songId, userName) {
    await sb.rpc('karaoke_queue_add', {
        p_room_id: ROOM_ID,
        p_song_id: songId,
        p_user_name: userName || null
    });
}

export async function upsertDeviceStatus(state, currentSong, queueLength, lastError) {
    await sb.from('device_status').upsert({
        room_id: ROOM_ID,
        updated_at: new Date().toISOString(),
        state,
        current_song: currentSong,
        queue_length: queueLength,
        last_error: lastError
    }, { onConflict: 'room_id' });
}
