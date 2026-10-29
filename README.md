# SimpleCut

Simple desktop video editor: join videos, add music, add text, auto captions (AI), export up to 1080p.

## Setup (once)
1. Install Python 3.9+ (tick "tcl/tk" on Windows installer; Linux: `sudo apt install python3-tk`)
2. Install FFmpeg and make sure `ffmpeg -version` works in a terminal
   - Windows: `winget install ffmpeg`   Mac: `brew install ffmpeg`
3. For auto captions: `pip install faster-whisper`

## Run
    python app.py

## How to use
- **Videos**: Add video, Trim (double-click), Up/Down to reorder
- **Sound**: Add music / voice-over, set start time and volume
- **Text**: Add titles anywhere on screen with start/end time
- **Captions**: pick language, press *Auto captions*, double-click a line to fix words
- Click the timeline to move the playhead and see that frame. "Play preview" renders a fast 480p preview.
- Bottom bar: choose 480p / 720p / 1080p, then **Export MP4**
- File menu saves/opens projects (.scut)

Tips: model `base` is fast, `small` is more accurate (better for Sinhala/Tamil). First run downloads the model.
