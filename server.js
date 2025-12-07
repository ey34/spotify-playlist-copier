const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const readline = require('readline');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('colors');

dotenv.config();

console.clear();

console.log(`Welcome to spotify playlist copier made by @ey34`.rainbow.bold);

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;
const port = process.env.PORT || 8888;
const TOKEN_PATH = path.join(__dirname, '.spotify_token.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query.cyan.bold, resolve));

let accessToken = null;
let serverInstance = null;

async function saveTokens(tokens) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
}

async function loadTokens() {
    if (fs.existsSync(TOKEN_PATH)) {
        return JSON.parse(fs.readFileSync(TOKEN_PATH));
    }
    return null;
}

async function refreshAccessToken(refresh_token) {
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh_token
        }), {
            headers: {
                'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const newTokens = response.data;
        if (!newTokens.refresh_token) {
            newTokens.refresh_token = refresh_token;
        }
        await saveTokens(newTokens);
        return newTokens.access_token;
    } catch (error) {
        console.log('Token refresh failed, please try again.'.red);
        return null;
    }
}

async function authenticate() {
    const savedTokens = await loadTokens();
    if (savedTokens && savedTokens.refresh_token) {
        console.log('Saved session found, refreshing token...'.yellow);
        const token = await refreshAccessToken(savedTokens.refresh_token);
        if (token) {
            accessToken = token;
            return accessToken;
        }
    }

    return new Promise((resolve, reject) => {
        const app = express();
        serverInstance = http.createServer(app);

        app.get('/callback', async (req, res) => {
            const code = req.query.code || null;
            if (!code) {
                res.send('Login failed, please try again.');
                return;
            }

            try {
                const authOptions = {
                    method: 'post',
                    url: 'https://accounts.spotify.com/api/token',
                    data: new URLSearchParams({
                        code: code,
                        redirect_uri: redirect_uri,
                        grant_type: 'authorization_code'
                    }),
                    headers: {
                        'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                };

                const response = await axios(authOptions);
                accessToken = response.data.access_token;
                await saveTokens(response.data);

                res.send('<h1>Login successful!</h1><p>You can close this window and return to the terminal.</p>');
                resolve(accessToken);
            } catch (error) {
                res.send('Token could not be retrieved.');
                reject(error);
            }
        });

        serverInstance.listen(port, async () => {
            console.log('----------------------------------------------------------'.rainbow);
            console.log('First setup requires Spotify login (only once).'.yellow);
            console.log(`Please approve in the opened browser window.`.green);

            const scope = 'user-read-private user-read-email playlist-read-private playlist-modify-public playlist-modify-private';
            const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
                response_type: 'code',
                client_id: client_id,
                scope: scope,
                redirect_uri: redirect_uri
            }).toString();

            try {
                const { default: open } = await import('open');
                await open(authUrl);
            } catch (err) {
                console.log('Puppeteer browser opening failed. Please click the following link:'.red);
                console.log(authUrl.underline.blue);
            }
        });
    });
}

async function getTargetPlaylists(userId) {
    try {
        const response = await axios.get(`https://api.spotify.com/v1/users/${userId}/playlists`, {
            headers: { 'Authorization': 'Bearer ' + accessToken },
            params: { limit: 50 }
        });
        return response.data.items;
    } catch (error) {
        // console.error('Error fetching playlists:'.red, error.response ? error.response.data : error.message);
        return [];
    }
}

async function copyPlaylist(playlist) {
    try {
        const meResponse = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const myId = meResponse.data.id;

        process.stdout.write(`\nPlaylist "${playlist.name}" is being created... `.cyan);
        const createResponse = await axios.post(`https://api.spotify.com/v1/users/${myId}/playlists`, {
            name: playlist.name,
            description: playlist.description || '',
            public: true
        }, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const newPlaylistId = createResponse.data.id;
        console.log('OK.'.green.bold);

        let tracks = [];
        let url = playlist.tracks.href;
        process.stdout.write('Fetching tracks...'.yellow);

        while (url) {
            process.stdout.write('.'.yellow);
            const tracksResponse = await axios.get(url, {
                headers: { 'Authorization': 'Bearer ' + accessToken }
            });

            const items = tracksResponse.data.items
                .filter(item => item && item.track && item.track.uri && !item.track.is_local)
                .map(item => item.track.uri);

            tracks = tracks.concat(items);
            url = tracksResponse.data.next;
        }
        console.log(` ${tracks.length} tracks found.`.green);

        for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        }

        if (tracks.length > 0) {
            process.stdout.write('Adding tracks...'.magenta);
            for (let i = 0; i < tracks.length; i += 100) {
                const batch = tracks.slice(i, i + 100);
                await axios.post(`https://api.spotify.com/v1/playlists/${newPlaylistId}/tracks`, {
                    uris: batch
                }, {
                    headers: { 'Authorization': 'Bearer ' + accessToken }
                });
                process.stdout.write('.'.magenta);
            }
            console.log(' Done!'.green.bold);
        } else {
            console.log('No valid tracks found to copy.'.red);
        }

    } catch (error) {
        console.error(`\nAn error occurred while copying playlist (${playlist.name}):`.red, error.message);
    }
}

async function main() {
    try {
        await authenticate();
        if (serverInstance) serverInstance.close();
        console.log('\nLogin successful!'.green.bold);
        console.log('----------------------------------------------------------'.rainbow);

        while (true) {
            // https://open.spotify.com/user/3nwgygqzwengb9a6x5qyb9yn5?si=65254ef6143348e3
            // 3nwgygqzwengb9a6x5qyb9yn5 (example it might be longer or shorter)
            const targetUser = await askQuestion('\nTarget Spotify ID (right click profile and copy profile url) (exit to quit): ');
            if (targetUser.toLowerCase() === 'exit') break;

            console.log(`Searching for playlists of ${targetUser}...`.cyan);

            let displayName = targetUser;
            try {
                const userProfile = await axios.get(`https://api.spotify.com/v1/users/${targetUser}`, {
                    headers: { 'Authorization': 'Bearer ' + accessToken }
                });
                displayName = userProfile.data.display_name;
            } catch (e) {
            }

            const playlists = await getTargetPlaylists(targetUser);

            if (playlists.length === 0) {
                console.log('No public playlists found or user not found.'.red);
                continue;
            }

            console.log(`\n${displayName.magenta.bold}'s available playlists:`);
            playlists.forEach((p, index) => {
                console.log(`${index + 1}. ${p.name.white} (${p.tracks.total} şarkı)`.gray);
            });

            const selection = await askQuestion('\nWrite the numbers of the playlists to copy (e.g. "1, 3, 5" or "all"): ');

            let selectedIndices = [];
            if (selection.toLowerCase() === 'all') {
                selectedIndices = playlists.map((_, i) => i);
            } else {
                selectedIndices = selection.split(',')
                    .map(s => parseInt(s.trim()) - 1)
                    .filter(i => !isNaN(i) && i >= 0 && i < playlists.length);
            }

            if (selectedIndices.length === 0) {
                console.log('Invalid selection.'.red);
                continue;
            }

            console.log(`\n${selectedIndices.length} playlist(s) copied.`.blue.bold);

            for (const index of selectedIndices) {
                await copyPlaylist(playlists[index]);
            }

            console.log('\nAll playlists copied successfully!'.green.bold);
        }

    } catch (error) {
        console.error('An error occurred:'.red, error);
    } finally {
        rl.close();
        process.exit(0);
    }
}

main();
