(function() {
	const fs = require('fs');
	const axios = require('axios');
	const converter = require('xml-js');
	const utils = require('#lib/utils.js');

	let categoriesList = null;
	const onDemandCategories = async (config, region, bootData) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await axios.get('https://service-vod.clusters.pluto.tv/v4/vod/categories?includeItems=false&includeCategoryFields=iconSvg&offset=1000&page=1&sort=number%3Aasc', {headers});

		categoriesList = resp.data;
		return categoriesList;
	}

	const getItems = async (config, region, categoryID, bootData) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await axios.get(`https://service-vod.clusters.pluto.tv/v4/vod/categories/${categoryID}/items?offset=0&page=1`, {headers});
		return resp.data;
	}

	const getVodItem = async (config, region, id, bootData) => {
		const jwt = bootData.sessionToken;
		const headers = {
			Authorization: `Bearer ${jwt}`
		};

		if (region) headers['X-Forwarded-For'] = config.get('mapping')[region];

		const resp = await axios.get(`https://service-vod.clusters.pluto.tv/v4/vod/items?ids=${id}`, {headers});
		return resp.data ? resp.data[0] : {};
	}

	// TODO: consolidate this and the life playlist generation code
	const generateM3U8 = async (config, region, bootData) => {
		const xTvgUrl = config.get('xTvgUrl');
		let cache = {};
		let newCache = {};
		let numChannels = 0;
		let chNo = 9000;
		// --- On-demand filters (added 2026-10-10) ---
		// The raw catalog emits one entry per (movie x category) pair, so the same film
		// repeats across ~379 categories: 15,018 entries / 62 MB for ~2,500 unique movies.
		// That file is too heavy for low-memory Android TV boxes to download+parse, so the
		// Pluto Movies source silently yields 0 channels and its sidebar entry disappears.
		// Three filters cut it back to a lean, unique, English, modern set:
		//   1. dedupe by _id     -> each movie emitted once (biggest win)
		//   2. year >= 2000      -> drop the old tail (clip.originalReleaseDate, ~99.8%)
		//   3. ASCII-only title  -> drop accented/non-Latin (mostly Spanish) titles; the
		//      VOD API has no audio-language field, so this is a heuristic, not exact.
		const MIN_RELEASE_YEAR = 2000;
		const seenIds = new Set();
		const isAscii = (s) => { for (let k = 0; k < s.length; k++) if (s.charCodeAt(k) > 127) return false; return true; };
		let m3u8 = "#EXTM3U\n\n";
		let fullTvgUrl = false;

		if (xTvgUrl) fullTvgUrl = xTvgUrl + (xTvgUrl.endsWith('/') ? `plutotv_ondemand_${region}.xml` : '');

		// try to init the cache
		const outdir = config.get('outdir') || '.';
		const cachefile = `${outdir}/plutotv_ondemand_${region}.cache`;
		try {
			cache = JSON.parse(fs.readFileSync(cachefile, 'utf-8'));
		} catch (ex) {
			cache = {};
		}

		if (xTvgUrl) {
			m3u8 = `#EXTM3U x-tvg-url="${xTvgUrl}"\n\n`;
		}

		let cacheDirty = false;
		for (let i = 0; i < categoriesList.categories.length; i++) {
			const c = categoriesList.categories[i];
			if (!c) continue;

			console.log("---------------------------", c.name, i, categoriesList.categories.length);
			const items = await getItems(config, region, c._id, bootData);
			const catname = items.name;

			for (let j = 0; j < items.items.length; j++) {
				const item = items.items[j];
				const id = item._id;

				if (item.type !== 'movie') continue;

				// Filter 1: dedupe - skip a movie already emitted from an earlier category.
				if (seenIds.has(id)) continue;
				// Filter 2: latest films - drop release years before MIN_RELEASE_YEAR.
				const relYear = item.clip && item.clip.originalReleaseDate
				    ? parseInt(item.clip.originalReleaseDate.substring(0, 4), 10)
				    : NaN;
				if (!isNaN(relYear) && relYear < MIN_RELEASE_YEAR) continue;
				// Filter 3: English-only heuristic - drop non-ASCII (accented/non-Latin) titles.
				if (!item.name || !isAscii(item.name)) continue;

				seenIds.add(id);
				console.log(item.name, j);
				cacheDirty |= !cache[`${id}-${region}`];
				const vodItem = cache[`${id}-${region}`] || await getVodItem(config, region, id, bootData);
				if (!vodItem) continue;

				newCache[`${id}-${region}`] = cache[`${id}-${region}`] = vodItem;

				const path = vodItem.stitched.path || vodItem.stitched.paths && vodItem.stitched.paths.filter(e => e.type === 'hls')?.path || false;
				if (!path) continue;

				const tvgChno = chNo++;
				const url = `${bootData.servers.stitcher}/v2${path}?${bootData.stitcherParams}&jwt=${bootData.sessionToken}&masterJWTPassthrough=true`;
				m3u8 += `#EXTINF:-1 tvg-id="${id}-${region}" tvg-logo="${vodItem.featuredImage.path}" tvg-chno="${tvgChno}" group-title="${catname}", ${vodItem.name}\n${url}\n\n`;
				numChannels++;

				newCache[`${id}-${region}`].stream_url = url;
			}
			if (cacheDirty) try {
				cacheDirty = false;
				fs.writeFileSync(cachefile, JSON.stringify(cache), 'utf-8');
			} catch (ex) {}
		}

		try {
			newCache.categoriesList = categoriesList;
			fs.writeFileSync(cachefile, JSON.stringify(newCache), 'utf-8');
		} catch (ex) {
			console.log("got ex", ex.message);
		}

		console.log("done");
		return { m3u8, numChannels }
	}

	const generateXMLTV = async (config, region) => {
		console.log("generating XMLTV for ondemand");
		let cache = false;
		// try to init the cache
		const outdir = config.get('outdir') || '.';
		const cachefile = `${outdir}/plutotv_ondemand_${region}.cache`;
		try {
			cache = JSON.parse(fs.readFileSync(cachefile, 'utf-8'));
		} catch (ex) {
			cache = false;
		}

		if (!cache) return "";

		const obj = {
			"_declaration": {
				"_attributes": {
					"version": "1.0",
					"encoding": "UTF-8"
				}
			},
			"_doctype": "tv SYSTEM \"xmltv.dtv\"",
			"tv": {
				"_attributes": {
					"source-info-name": "nobody,xmltv.net,nzxmltv.com"
				},
				"channel": [],
				"programme": []
			}
		};

		const channelIds = Object.keys(cache);
		for (let i = 0; i < channelIds.length; i++) {
			const id = channelIds[i];
			if (id === 'categoriesList') continue;

			const entry = cache[id];
			const channel = {
				"_attributes": {
					"id": id
				},
				"display-name": {
					"_text": entry.name
				},
				"icon": {
					"_attributes": {
						"src": utils.escapeHTML(entry.featuredImage.path)
					}
				}
			}

			const start = new Date(); start.setDate(start.getDate() - 1);
			const stop = new Date(); stop.setDate(stop.getDate() + 1);
			const programme = {
				"_attributes": {
					"channel": id,
					"start": `${utils.getTimeStr(start)} +0000`,
					"stop": `${utils.getTimeStr(stop)} +0000`
				},
				"title": {
					"_text": entry.name
				},
				"desc": {
					"_text": entry.description
				},
				"icon": {
					"_attributes": {
						"src": utils.escapeHTML(entry.featuredImage.path)
					}
				}
			}
			obj.tv.programme.push(programme);
		}

		console.log("converting");
		return converter.json2xml(JSON.stringify(obj), {compact: true, ignoreComment: true, spaces: 4});
	}

	exports = module.exports = {
		onDemandCategories,
		getItems,
		generateM3U8,
		generateXMLTV
	}
})();
