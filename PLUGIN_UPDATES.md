# Merchant Autofill Plugin Updates

## ✨ New Features

### 1. Connection Status at Top
- Helper tool connection status now appears at the top of the plugin
- Shows green dot when connected, red when disconnected
- Provides clear feedback before you start working

### 2. Customizable Layer Names
Added a new settings section that allows you to customize which layer names the plugin looks for:

**Layer Name Settings:**
- **Name Layer** - Default: "Merchant name"
- **Logo Layer** - Default: "Logo"
- **Image Layer** - Default: "Hero"

**How it works:**
- Leave fields empty to use default layer names
- Enter custom names to match your Figma file structure
- Settings are automatically saved in your browser
- Shows placeholders with default values for reference

**Example Use Cases:**
- If your cards use "Title" instead of "Merchant name", just type "Title"
- If you use "Background" instead of "Hero", type "Background"
- Works with any naming convention your team uses!

### 3. Auto-Resizing Plugin Window
- Plugin starts at **220px height** (compact view)
- Expands to **480px height** when you open settings
- Shrinks back to 220px when you close settings
- Smooth transition for better UX

### 4. Reorganized Settings Panel
New settings layout:
```
┌─────────────────────────────────┐
│  Settings (gear icon)            │
├─────────────────────────────────┤
│  Credits                         │
│  "Made for Affirm by..."         │
├─────────────────────────────────┤
│  Layer Names                     │
│  ├─ Name Layer: [input]          │
│  ├─ Logo Layer: [input]          │
│  └─ Image Layer: [input]         │
├─────────────────────────────────┤
│  Server URL                      │
│  [http://localhost:8787]         │
└─────────────────────────────────┘
```

## 🔧 Technical Changes

### UI (ui.html)
- Moved connection status from footer to header
- Added layer name input fields with labels
- Implemented localStorage for settings persistence
- Added resize message to Figma plugin API
- Auto-save settings on input change

### Plugin Logic (code.js)
- Added `RESIZE` message handler to resize plugin window
- Pass `layerNames` object through all functions
- Updated `findMerchantCardsInSelection()` to use custom layer names
- Updated `isMerchantCard()` to check custom layer names
- Updated `populateCard()` to find nodes by custom names
- Updated `createMerchantCard()` to create nodes with custom names

## 📝 Usage Instructions

### First Time Setup
1. Click the gear icon to open settings
2. (Optional) Customize layer names to match your Figma structure
3. Verify server URL is correct (default: http://localhost:8787)
4. Start using the plugin!

### Daily Usage
1. Check that green dot shows "Connected to helper tool"
2. Enter merchant names (comma separated)
3. Select cards to update OR leave nothing selected to create new cards
4. Click Run

### Customizing for Your Team
If your team uses different layer naming:
1. Open settings (gear icon)
2. Update layer names to match your conventions
3. Settings persist across plugin reopens
4. Share your naming convention with your team

## 🎨 Design Improvements

- **Cleaner Layout**: Connection status at top, settings organized by category
- **Better UX**: Plugin resizes to show/hide settings smoothly
- **Flexibility**: Works with any layer naming convention
- **Persistence**: Settings saved automatically, no manual save needed
- **Clear Defaults**: Placeholder text shows default values

## 🐛 Bug Fixes

- Layer name lookups now respect user configuration
- Settings persist across plugin sessions
- Plugin window size adapts to content

## 📊 Settings Storage

Settings are stored in browser localStorage with this structure:
```json
{
  "serverUrl": "http://localhost:8787",
  "layerNames": {
    "name": "Merchant name",
    "logo": "Logo",
    "hero": "Hero"
  }
}
```

## 💡 Tips

1. **Keep defaults if they work** - Only change layer names if your cards use different names
2. **Match exactly** - Layer name matching is case-sensitive
3. **Test with one card first** - Verify custom names work before batch processing
4. **Empty = Default** - Leaving a field empty uses the built-in default

## 🚀 What's Next?

The plugin is now more flexible and can adapt to different team workflows. Future enhancements could include:
- Layer name presets for common setups
- Visual preview of which layers will be affected
- Bulk layer renaming tools
- Export/import settings for team sharing
