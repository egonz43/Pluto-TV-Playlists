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
		// repeats across ~379 categories: 15,018 entries / 62 MB of largely duplicate rows.
		// That file is too heavy for low-memory Android TV boxes to download+parse, so the
		// Pluto Movies source silently yields 0 channels and its sidebar entry disappears.
		// One filter cuts it back to a lean, unique set - duplicates removed only:
		//   1. dedupe by _id     -> each movie emitted once (biggest win)
		// --- Canonical genre taxonomy (added 2026-10-11) ---
		// Pluto returns ~379 micro-categories; collapse them into a fixed rail set and pick each
		// movie's genre by curated priority (specific genres first, catch-all buckets last) so a
		// multi-genre film lands in its most descriptive rail, not whatever Pluto listed first.
		// v3: Spanish-language buckets, cult/commentary brands (MST3K, RiffTrax, Closet Picks) and LGBTQ
		// categories are EXCLUDED from the playlist entirely via SKIP_CATEGORY_RE; the catch-all buckets
		// 'Most Popular Movies' / 'Top Titles' keep their own named rails.
		const GENRE_RULES = [
			[/kid|family|children|tween|teen/i, 'Kids & Family'],
			[/anim|cartoon|anime/i, 'Animation'],
			[/horror|scary|slasher|zombie|paranormal/i, 'Horror'],
			[/sci-?fi|fantasy|superhero|comic|marvel/i, 'Sci-Fi & Fantasy'],
			[/thriller|suspen|mystery|crime|heist|noir|detective/i, 'Thriller & Crime'],
			[/roman|love|wedding|holiday|christmas/i, 'Romance'],
			[/stand-?up|music|concert/i, 'Stand-Up & Music'],
			[/comed|funny|humou?r/i, 'Comedy'],
			[/action|adventure|martial|war|military|western/i, 'Action'],
			[/realit|talk show|game show|lifestyle|food|cooking|home|diy/i, 'Reality'],
			[/sport|fitness|wrestling|boxing|mma|pga|golf|nascar|tennis|soccer|football|basketball|hockey|racing/i, 'Sports'],
			[/documentar|docuser|biograph|histor|nature|science|travel/i, 'Documentary'],
			[/drama|indie|classic|award/i, 'Drama'],
			[/most popular/i, 'Most Popular Movies'],
			[/top titles/i, 'Top Titles']
		];
		const GENRE_PRIORITY = ['Kids & Family','Animation','Horror','Sci-Fi & Fantasy','Thriller & Crime','Romance','Stand-Up & Music','Comedy','Action','Reality','Sports','Documentary','Drama','Most Popular Movies','Top Titles'];
		const CATCHALL_RE = /top|new|recent|popular|featured|trending|best|editor|staff|pick|must|hidden|leaving|adding|because you/i;
		// Excluded from the playlist entirely (user decision 2026-10-11): Spanish-language buckets,
		// cult/commentary brands and LGBTQ categories. Skipped before the items fetch so they cost no
		// API calls and contribute no entries; a movie that also lives in a kept category still appears
		// there, because the skip is per category, not per movie.
		const SKIP_CATEGORY_RE = /pelicula|espanol|latino|navidad|doblado|mst3k|rifftrax|closet picks|lgbtq?|queer|pride/i;
		const foldAccents = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
		const canonGenre = (name) => {
			if (!name) return 'Uncategorised';
			const folded = foldAccents(name);
			for (const [re, genre] of GENRE_RULES) if (re.test(folded)) return genre;
			return 'Uncategorised';
		};
		const genreRank = (name) => {
			if (!name || CATCHALL_RE.test(name)) return 1000;
			const idx = GENRE_PRIORITY.indexOf(canonGenre(name));
			return idx < 0 ? 999 : idx;
		};
		const seenIds = new Set();
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

		// Curated priority: specific genres first, catch-all buckets last, so dedupe files each
		// movie under its most descriptive genre. Sort is stable; ties keep Pluto's order.
		categoriesList.categories = categoriesList.categories.filter(Boolean).sort((a, b) => genreRank(a && a.name) - genreRank(b && b.name));
		let cacheDirty = false;
		for (let i = 0; i < categoriesList.categories.length; i++) {
			const c = categoriesList.categories[i];
			if (!c) continue;
			// foldAccents is required here: Pluto spells these buckets with accents
			// ("Películas", "español"), so an un-folded test never matches SKIP_CATEGORY_RE
			// and the Spanish rails leak into the playlist. canonGenre() already folds.
			if (SKIP_CATEGORY_RE.test(foldAccents(c.name || ''))) continue;

			console.log("---------------------------", c.name, i, categoriesList.categories.length);
			const items = await getItems(config, region, c._id, bootData);
			const catname = items.name;

			for (let j = 0; j < items.items.length; j++) {
				const item = items.items[j];
				const id = item._id;

				if (item.type !== 'movie') continue;

				// Filter 1: dedupe - skip a movie already emitted from an earlier category.
				if (seenIds.has(id)) continue;

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
				m3u8 += `#EXTINF:-1 tvg-id="${id}-${region}" tvg-logo="${vodItem.featuredImage.path}" tvg-chno="${tvgChno}" group-title="${canonGenre(catname)}", ${vodItem.name}\n${url}\n\n`;
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
