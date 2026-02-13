Merchant Autofill - Setup Instructions

1. Move all these files into a single folder.

2. START THE HELPER
   - Open the 'server' folder.
   - Right-click 'RUN THIS.command' and select 'Open'.
   - If prompted with a security warning, click 'Open' anyway.
   - Keep the Terminal window open while using the plugin.

3. LOAD THE PLUGIN IN FIGMA
   - In Figma, right click on a blank area.
   - From the context menu, select Plugins > Development > Import plugin from manifest...
   - Navigate to the 'plugin' folder and select the 'manifest.json' file inside.

4. USAGE INSTRUCTIONS

   IMPORTANT: Layer names must be EXACTLY:
   - "Hero" for hero image
   - "Logo" for logo image
   - "Merchant name" for merchant name

   SCENARIO 1: Populate Multiple Cards
   - Ensure your card layers have the exact names above.
   - Select the parent container containing all the cards.
   - Run the plugin and enter merchant names.

   SCENARIO 2: Update Single Card
   - Ensure your card layers have the exact names above.
   - Select the individual card you want to update.
   - Run the plugin and enter the merchant name.

   SCENARIO 3: No Layout (Create New Cards)
   - Don't have a layout yet? No problem!
   - Simply run the plugin with merchant names.
   - The plugin will automatically create cards with all assets included.

5. NEED HELP?
   - Contact Ani for any questions, suggestions, or bug reports.