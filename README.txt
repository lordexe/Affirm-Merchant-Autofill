Merchant Autofill - Setup Instructions

HOW IT WORKS
   The plugin fetches merchant data (logo, hero image, name) directly from
   Affirm's public marketplace API — no server or extra setup required.

---

1. LOAD THE PLUGIN IN FIGMA
   - In Figma, right-click on a blank area.
   - Select Plugins > Development > Import plugin from manifest...
   - Navigate to the 'plugin' folder and select 'manifest.json'.

2. USAGE INSTRUCTIONS

   LAYER NAMES (Customizable):
   By default, the plugin looks for these layer names:
   - "Hero" for hero image
   - "Logo" for logo image
   - "Merchant name" for merchant name

   NOTE: You can customize these layer names in the plugin settings (gear icon).
   Use the toggles to control which layers to populate.

   SCENARIO 1: Populate Multiple Cards
   - Ensure your card layers have the exact names above.
   - Select the parent container containing all the cards.
   - Run the plugin and enter merchant names.

   SCENARIO 2: Update a Single Card
   - Ensure your card layers have the exact names above.
   - Select the individual card you want to update.
   - Run the plugin and enter the merchant name.

   SCENARIO 3: No Layout (Create New Cards)
   - Don't have a layout yet? No problem!
   - Simply run the plugin with merchant names.
   - The plugin will automatically create cards with all assets included.

3. INSTALL
   https://www.figma.com/community/plugin/1605836369789220276

---

NOTE: The 'server' folder is a legacy method from an earlier version of this
plugin that required a local proxy server to fetch data. It is no longer used
and can be ignored.
