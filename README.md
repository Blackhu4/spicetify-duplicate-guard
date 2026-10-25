# Duplicate Guard

A [Spicetify](https://spicetify.app) extension that keeps duplicate tracks out of your playlists and Liked Songs.

## Features

- **Warns before adding** a track that is already in the target playlist or in Liked Songs. It matches the exact same track *and* the same title + artist from a different release (single vs. album, remaster, etc.).
- **Works with the heart button**, "Add to playlist" and drag & drop.
- When adding several tracks at once you can **skip only the duplicates**, add everything anyway, or cancel.
- **Scan an existing playlist or Liked Songs** for duplicates. A dialog lists every track that appears more than once together with its album. Choose which copies to remove; at least one copy of each track always stays.

## Installation

### Marketplace

Open **Marketplace** in Spotify, go to the **Extensions** tab, search for *Duplicate Guard* and click **Install**.

### Manual

1. Download `duplicate-guard.js` and put it into your Spicetify `Extensions` folder (run `spicetify path userdata` or see the Spicetify docs to find it).
2. Run:

   ```bash
   spicetify config extensions duplicate-guard.js
   spicetify apply
   ```

## Usage

- **Adding tracks:** just use Spotify as usual. If the track is already there, a dialog appears.
- **Scanning a list:** right-click a playlist (or Liked Songs) and choose **Find duplicates**, or open the list and click the **Find duplicates** button in the top bar.

## Notes and limitations

- Duplicates are detected by comparing title and first artist (case, accents and extra spaces are ignored). Two different songs that share a title and an artist would be treated as duplicates, which is why removal always needs your confirmation.
- Liked Songs are read through the Spotify Web API. With a very large library you may occasionally hit rate limiting (HTTP 429); wait a moment and try again.
- This extension relies on internal Spotify APIs that can change between Spotify versions. If something stops working, please open an issue and include your Spotify and Spicetify versions.
- Set `DEBUG` to `true` at the top of `duplicate-guard.js` to show on-screen debug notifications.

## License

MIT
