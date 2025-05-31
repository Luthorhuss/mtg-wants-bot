const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const https = require('https');

// Bot configuration
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Storage for card wants and pinned message tracking
const serverData = new Map(); // guildId -> { userWants: Map, pinnedMessageId: string, channelId: string }

// Card name cache to reduce API calls
const cardCache = new Map(); // cardName -> { exactName: string, timestamp: number }
const setCache = new Map(); // setCode -> { setName: string, timestamp: number }
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiting for Scryfall API (they allow ~10 requests/second)
let lastApiCall = 0;
const API_DELAY = 100; // 100ms between calls

// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('wants')
        .setDescription('Manage your MTG card wants list')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Action to perform (+card, -card, clear, help, or mixed like "+1 bolt (M25, foil) -2 opt")')
                .setRequired(true)
        ),
];

// Register slash commands
async function registerCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE');
        
        console.log('Started refreshing application (/) commands.');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Enhanced card specification parser
function parseCardSpecification(input) {
    // Remove extra whitespace
    input = input.trim();
    
    // Pattern to match: cardname (set, foil) or cardname (set) or cardname (foil)
    const specMatch = input.match(/^(.+?)\s*(?:\(([^)]+)\))?\s*$/);
    
    if (!specMatch) {
        return {
            cardName: input,
            setCode: null,
            foil: false
        };
    }
    
    const cardName = specMatch[1].trim();
    const specification = specMatch[2];
    
    let setCode = null;
    let foil = false;
    
    if (specification) {
        // Split by comma and process each part
        const parts = specification.split(',').map(p => p.trim().toLowerCase());
        
        for (const part of parts) {
            if (part === 'foil') {
                foil = true;
            } else {
                // Assume it's a set code or set name
                setCode = part;
            }
        }
    }
    
    return {
        cardName,
        setCode,
        foil
    };
}

// Create a unique key for storage
function createCardKey(cardName, setCode, foil) {
    let key = cardName;
    if (setCode) {
        key += `|${setCode}`;
    }
    if (foil) {
        key += '|foil';
    }
    return key;
}

// Parse card key back to components
function parseCardKey(key) {
    const parts = key.split('|');
    return {
        cardName: parts[0],
        setCode: parts[1] || null,
        foil: parts.includes('foil')
    };
}

// Format card display name
function formatCardDisplay(cardName, setCode, foil, setName = null) {
    let display = cardName;
    
    if (setCode || setName) {
        const setDisplay = setName || setCode;
        display += ` (${setDisplay}${foil ? ', foil' : ''})`;
    } else if (foil) {
        display += ' (foil)';
    }
    
    return display;
}

// Improved Scryfall API functions
async function makeApiRequest(url) {
    return new Promise((resolve, reject) => {
        // Rate limiting
        const now = Date.now();
        const timeSinceLastCall = now - lastApiCall;
        if (timeSinceLastCall < API_DELAY) {
            setTimeout(() => {
                makeApiRequest(url).then(resolve).catch(reject);
            }, API_DELAY - timeSinceLastCall);
            return;
        }
        lastApiCall = Date.now();

        console.log(`Fetching from Scryfall: ${url}`);
        
        const options = {
            method: 'GET',
            headers: {
                'User-Agent': 'MTG-Discord-Bot/1.0',
                'Accept': 'application/json'
            },
            timeout: 10000
        };

        const req = https.request(url, options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    if (!data) {
                        return reject(new Error('Empty response from Scryfall API'));
                    }

                    const response = JSON.parse(data);
                    
                    if (res.statusCode !== 200) {
                        if (response.object === 'error') {
                            if (response.code === 'not_found') {
                                return reject(new Error('Not found'));
                            } else if (response.code === 'ambiguous') {
                                return reject(new Error('Ambiguous name'));
                            } else {
                                return reject(new Error(response.details || `API error: ${response.code}`));
                            }
                        } else {
                            return reject(new Error(`HTTP ${res.statusCode}: ${response.message || 'Unknown error'}`));
                        }
                    }
                    
                    resolve(response);
                } catch (parseError) {
                    reject(new Error('Failed to parse API response'));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error(`Failed to connect to API: ${error.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('API request timed out'));
        });

        req.setTimeout(10000);
        req.end();
    });
}

async function searchSetByCode(setIdentifier) {
    try {
        // Check cache first
        const cached = setCache.get(setIdentifier.toLowerCase());
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            return cached.setName;
        }

        const encodedSet = encodeURIComponent(setIdentifier);
        const url = `https://api.scryfall.com/sets/${encodedSet}`;
        
        const response = await makeApiRequest(url);
        
        if (response.object === 'set' && response.name) {
            const setName = response.name;
            const setCode = response.code;
            
            // Cache both the provided identifier and the official code
            setCache.set(setIdentifier.toLowerCase(), {
                setName: setName,
                setCode: setCode,
                timestamp: Date.now()
            });
            setCache.set(setCode.toLowerCase(), {
                setName: setName,
                setCode: setCode,
                timestamp: Date.now()
            });
            
            return setName;
        } else {
            throw new Error('Invalid set response');
        }
    } catch (error) {
        // Try searching by name if code lookup failed
        try {
            const url = `https://api.scryfall.com/sets?q=${encodeURIComponent(setIdentifier)}`;
            const response = await makeApiRequest(url);
            
            if (response.object === 'list' && response.data && response.data.length > 0) {
                // Find exact match first, then fuzzy match
                let set = response.data.find(s => 
                    s.code.toLowerCase() === setIdentifier.toLowerCase() ||
                    s.name.toLowerCase() === setIdentifier.toLowerCase()
                );
                
                if (!set) {
                    set = response.data.find(s => 
                        s.name.toLowerCase().includes(setIdentifier.toLowerCase()) ||
                        s.code.toLowerCase().includes(setIdentifier.toLowerCase())
                    );
                }
                
                if (set) {
                    setCache.set(setIdentifier.toLowerCase(), {
                        setName: set.name,
                        setCode: set.code,
                        timestamp: Date.now()
                    });
                    return set.name;
                }
            }
            
            throw new Error(`Set "${setIdentifier}" not found`);
        } catch (searchError) {
            throw new Error(`Set "${setIdentifier}" not found`);
        }
    }
}

async function searchCardOnScryfall(cardName, setCode = null) {
    try {
        // Create cache key
        const cacheKey = `${cardName.toLowerCase()}${setCode ? `|${setCode.toLowerCase()}` : ''}`;
        const cached = cardCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
            console.log(`Cache hit for: ${cardName} -> ${cached.exactName}`);
            return cached;
        }

        let url;
        if (setCode) {
            // Search for specific printing
            const encodedName = encodeURIComponent(cardName.trim());
            const encodedSet = encodeURIComponent(setCode.trim());
            url = `https://api.scryfall.com/cards/named?fuzzy=${encodedName}&set=${encodedSet}`;
        } else {
            // Search for any printing
            const encodedName = encodeURIComponent(cardName.trim());
            url = `https://api.scryfall.com/cards/named?fuzzy=${encodedName}`;
        }
        
        const response = await makeApiRequest(url);
        
        if (response.object === 'card' && response.name) {
            const result = {
                exactName: response.name,
                setCode: response.set,
                setName: response.set_name,
                timestamp: Date.now()
            };
            
            // Cache the result
            cardCache.set(cacheKey, result);
            
            console.log(`Successfully found card: ${cardName} -> ${result.exactName} (${result.setName})`);
            return result;
        } else {
            throw new Error('Invalid card response');
        }
    } catch (error) {
        if (setCode && error.message === 'Not found') {
            throw new Error(`Card "${cardName}" not found in set "${setCode}"`);
        } else if (error.message === 'Ambiguous name') {
            throw new Error(`Card name "${cardName}" is ambiguous. Please be more specific.`);
        } else if (error.message === 'Not found') {
            throw new Error(`Card "${cardName}" not found`);
        } else {
            throw error;
        }
    }
}

// Test Scryfall connection function
async function testScryfallConnection() {
    try {
        console.log('Testing Scryfall API connection...');
        const testCard = await searchCardOnScryfall('Lightning Bolt');
        console.log(`✅ Scryfall API test successful: ${testCard.exactName}`);
        return true;
    } catch (error) {
        console.error('❌ Scryfall API test failed:', error.message);
        return false;
    }
}

// Parse multiple operations from a single command
function parseMultipleOperations(input) {
    const operations = [];
    
    // Enhanced regex to handle parentheses in card specifications
    // Matches: +1 Lightning Bolt (M25, foil) -2 Opt +3 Island (foil)
    const regex = /([+-])(\d+)\s+([^+-]+?)(?=\s*[+-]\d+|$)/g;
    let match;
    
    while ((match = regex.exec(input)) !== null) {
        const operation = match[1]; // + or -
        const quantity = parseInt(match[2]);
        const cardSpec = match[3].trim();
        
        const parsed = parseCardSpecification(cardSpec);
        
        operations.push({
            operation,
            quantity,
            ...parsed
        });
    }
    
    // If no matches found, try single operation format
    if (operations.length === 0) {
        const singleMatch = input.match(/^([+-])(\d+)\s+(.+)$/);
        if (singleMatch) {
            const parsed = parseCardSpecification(singleMatch[3].trim());
            operations.push({
                operation: singleMatch[1],
                quantity: parseInt(singleMatch[2]),
                ...parsed
            });
        }
    }
    
    return operations;
}

// Bot ready event
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    await registerCommands();
    
    // Test Scryfall connection on startup
    await testScryfallConnection();
});

// Slash command handler
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'wants') return;

    const args = interaction.options.getString('action');
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    const guildId = interaction.guild.id;

    // Initialize server data if not exists
    if (!serverData.has(guildId)) {
        serverData.set(guildId, {
            userWants: new Map(),
            pinnedMessageId: null,
            channelId: interaction.channel.id
        });
    }

    const data = serverData.get(guildId);

    try {
        if (args.toLowerCase() === 'clear') {
            // Clear user's wants list
            const result = await handleClearWants(userId, username, data);
            if (result.success) {
                await updatePinnedMessage(interaction.channel, data);
            }
            await interaction.reply({ content: result.message, ephemeral: true });
        } else if (args === '' || args.toLowerCase() === 'help') {
            // Show help
            await showHelp(interaction);
        } else {
            // Handle multiple operations
            await interaction.deferReply({ ephemeral: true });
            const result = await handleMultipleOperations(args, userId, username, data);
            
            if (result.hasChanges) {
                await updatePinnedMessage(interaction.channel, data);
            }
            
            await interaction.editReply({ content: result.message });
        }
    } catch (error) {
        console.error('Error handling command:', error);
        
        if (interaction.deferred) {
            await interaction.editReply({ content: '❌ An error occurred while processing your command.' });
        } else if (!interaction.replied) {
            await interaction.reply({ 
                content: '❌ An error occurred while processing your command.', 
                ephemeral: true 
            });
        }
    }
});

// Legacy message command support (for backward compatibility)
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!wants')) return;

    const args = message.content.slice(6).trim();
    const userId = message.author.id;
    const username = message.author.displayName || message.author.username;
    const guildId = message.guild.id;

    // Initialize server data if not exists
    if (!serverData.has(guildId)) {
        serverData.set(guildId, {
            userWants: new Map(),
            pinnedMessageId: null,
            channelId: message.channel.id
        });
    }

    const data = serverData.get(guildId);

    try {
        if (args.toLowerCase() === 'clear') {
            const result = await handleClearWants(userId, username, data);
            if (result.success) {
                await updatePinnedMessage(message.channel, data);
            }
            await message.reply(result.message);
        } else if (args === '' || args.toLowerCase() === 'help') {
            await showHelpLegacy(message);
        } else {
            // Send "processing" message for complex operations
            const processingMsg = await message.reply('🔄 Processing your request and validating cards...');
            
            const result = await handleMultipleOperations(args, userId, username, data);
            
            if (result.hasChanges) {
                await updatePinnedMessage(message.channel, data);
            }
            
            await processingMsg.edit(result.message);
        }
    } catch (error) {
        console.error('Error handling legacy command:', error);
        await message.reply('❌ An error occurred while processing your command.');
    }
});

async function handleMultipleOperations(input, userId, username, data) {
    const operations = parseMultipleOperations(input);
    
    if (operations.length === 0) {
        return {
            hasChanges: false,
            message: '❌ Invalid syntax! Use `/wants + [number] [card name]` to add, `/wants - [number] [card name]` to remove, or combine them like `/wants +1 Lightning Bolt (M25, foil) -2 Opt`'
        };
    }

    const results = [];
    const errors = [];
    let hasChanges = false;

    // Initialize user's wants if not exists
    if (!data.userWants.has(userId)) {
        data.userWants.set(userId, { username, cards: new Map() });
    }

    const userData = data.userWants.get(userId);
    userData.username = username;

    for (const op of operations) {
        try {
            console.log(`Processing operation: ${op.operation}${op.quantity} ${op.cardName} ${op.setCode ? `(${op.setCode})` : ''} ${op.foil ? '(foil)' : ''}`);
            
            if (op.operation === '+') {
                const result = await handleAddCardOperation(op, userData, data, userId);
                if (result.success) {
                    results.push(result.message);
                    hasChanges = true;
                } else {
                    errors.push(result.message);
                }
            } else if (op.operation === '-') {
                const result = await handleRemoveCardOperation(op, userData, data, userId);
                if (result.success) {
                    results.push(result.message);
                    hasChanges = true;
                } else {
                    errors.push(result.message);
                }
            }
        } catch (error) {
            console.error(`Error processing ${op.operation}${op.quantity} ${op.cardName}:`, error);
            errors.push(`❌ Error processing ${op.operation}${op.quantity} ${op.cardName}: ${error.message}`);
        }
    }

    // Clean up empty user entries
    if (userData.cards.size === 0) {
        data.userWants.delete(userId);
    }

    let message = '';
    if (results.length > 0) {
        message += results.join('\n');
    }
    if (errors.length > 0) {
        if (message) message += '\n\n';
        message += errors.join('\n');
    }

    return {
        hasChanges,
        message: message || '❌ No valid operations found.'
    };
}

async function handleAddCardOperation(cardOp, userData, data, userId) {
    const { cardName, setCode, foil, quantity } = cardOp;
    
    if (!cardName || cardName.trim() === '') {
        return {
            success: false,
            message: '❌ Card name cannot be empty.'
        };
    }

    if (isNaN(quantity) || quantity <= 0 || quantity > 99) {
        return {
            success: false,
            message: `❌ Quantity for "${cardName}" must be between 1 and 99.`
        };
    }

    if (cardName.length > 100) {
        return {
            success: false,
            message: `❌ Card name "${cardName}" is too long (max 100 characters).`
        };
    }

    // Validate card with Scryfall API
    let cardInfo, setName = null;
    try {
        console.log(`Searching for card: "${cardName}" ${setCode ? `in set "${setCode}"` : ''}`);
        cardInfo = await searchCardOnScryfall(cardName, setCode);
        setName = cardInfo.setName;
        console.log(`Found exact card: "${cardInfo.exactName}" in "${setName}"`);
        
        // If user provided a set but we found a different one, validate the user's set
        if (setCode && setCode.toLowerCase() !== cardInfo.setCode.toLowerCase()) {
            try {
                setName = await searchSetByCode(setCode);
            } catch (setError) {
                // Use the found card's set name
                setName = cardInfo.setName;
            }
        }
    } catch (error) {
        console.error(`Card search failed for "${cardName}":`, error.message);
        return {
            success: false,
            message: `❌ ${error.message}`
        };
    }

    // Create card key for storage
    const finalSetCode = setCode || cardInfo.setCode;
    const cardKey = createCardKey(cardInfo.exactName, finalSetCode, foil);
    
    // Check if user has too many different cards
    if (!userData.cards.has(cardKey) && userData.cards.size >= 50) {
        return {
            success: false,
            message: `❌ You can only want up to 50 different card specifications. Use \`clear\` to reset your list.`
        };
    }
    
    // Add or update card quantity
    const displayName = formatCardDisplay(cardInfo.exactName, finalSetCode, foil, setName);
    
    if (userData.cards.has(cardKey)) {
        const currentQty = userData.cards.get(cardKey);
        const newQty = Math.min(currentQty + quantity, 99);
        userData.cards.set(cardKey, newQty);
        return {
            success: true,
            message: `✅ Updated **${displayName}** to ${newQty} copies.`
        };
    } else {
        userData.cards.set(cardKey, quantity);
        return {
            success: true,
            message: `✅ Added **${quantity}x ${displayName}**.`
        };
    }
}

async function handleRemoveCardOperation(cardOp, userData, data, userId) {
    const { cardName, setCode, foil, quantity } = cardOp;
    
    if (userData.cards.size === 0) {
        return {
            success: false,
            message: '❌ Your wants list is empty.'
        };
    }

    if (isNaN(quantity) || quantity <= 0) {
        return {
            success: false,
            message: `❌ Quantity for "${cardName}" must be greater than 0.`
        };
    }

    // Find matching card key (case-insensitive card name matching)
    let matchingKey = null;
    let matchingDisplay = null;
    
    for (const [key, qty] of userData.cards.entries()) {
        const keyInfo = parseCardKey(key);
        
        // Check if card name matches (case-insensitive)
        if (keyInfo.cardName.toLowerCase() !== cardName.toLowerCase()) {
            continue;
        }
        
        // Check set code match (if specified)
        if (setCode) {
            if (!keyInfo.setCode || keyInfo.setCode.toLowerCase() !== setCode.toLowerCase()) {
                continue;
            }
        }
        
        // Check foil match
        if (keyInfo.foil !== foil) {
            continue;
        }
        
        matchingKey = key;
        matchingDisplay = formatCardDisplay(keyInfo.cardName, keyInfo.setCode, keyInfo.foil);
        break;
    }

    if (!matchingKey) {
        const searchDisplay = formatCardDisplay(cardName, setCode, foil);
        return {
            success: false,
            message: `❌ **${searchDisplay}** not found in your wants list.`
        };
    }

    const currentQty = userData.cards.get(matchingKey);

    if (quantity >= currentQty) {
        userData.cards.delete(matchingKey);
        return {
            success: true,
            message: `✅ Removed all copies of **${matchingDisplay}**.`
        };
    } else {
        userData.cards.set(matchingKey, currentQty - quantity);
        return {
            success: true,
            message: `✅ Removed ${quantity}x **${matchingDisplay}**. (${currentQty - quantity} remaining)`
        };
    }
}

async function handleClearWants(userId, username, data) {
    if (!data.userWants.has(userId) || data.userWants.get(userId).cards.size === 0) {
        return {
            success: false,
            message: '❌ Your wants list is already empty.'
        };
    }

    const userData = data.userWants.get(userId);
    const cardCount = userData.cards.size;
    
    // Clear all cards for this user
    data.userWants.delete(userId);
    
    return {
        success: true,
        message: `✅ Cleared all ${cardCount} card specifications from ${username}'s wants list.`
    };
}

async function updatePinnedMessage(channel, data) {
    try {
        let pinnedMessage = null;

        // Try to find existing pinned message
        if (data.pinnedMessageId) {
            try {
                pinnedMessage = await channel.messages.fetch(data.pinnedMessageId);
            } catch (error) {
                // Message doesn't exist anymore, reset the ID
                data.pinnedMessageId = null;
                console.log('Previous pinned message not found, will create new one');
            }
        }

        // Create embed with current wants
        const embed = createWantsEmbed(data.userWants);

        if (pinnedMessage && pinnedMessage.author.id === client.user.id) {
            // Update existing message
            await pinnedMessage.edit({ embeds: [embed] });
        } else {
            // Create new pinned message
            const newMessage = await channel.send({ embeds: [embed] });
            
            // Pin the message if bot has permissions
            if (channel.permissionsFor(client.user).has(PermissionFlagsBits.ManageMessages)) {
                try {
                    await newMessage.pin();
                } catch (error) {
                    console.log('Could not pin message:', error.message);
                }
            }
            
            // Update stored message ID
            data.pinnedMessageId = newMessage.id;
        }
    } catch (error) {
        console.error('Error updating pinned message:', error);
    }
}

function createWantsEmbed(userWants) {
    const embed = new EmbedBuilder()
        .setTitle('🎴 MTG Card Wants List')
        .setColor(0x7289DA)
        .setTimestamp();

    if (userWants.size === 0) {
        embed.setDescription('*No cards wanted yet. Use `/wants + [number] [card name]` to add cards!*\n\n*Examples:*\n`/wants +2 Lightning Bolt (M25)`\n`/wants +1 Lightning Bolt (M25, foil)`\n`/wants +3 Lightning Bolt (foil)`\n\n*You can also combine operations:*\n`/wants +1 Lightning Bolt (M25, foil) -2 Opt`');
        return embed;
    }

    let description = '';
    let totalSpecs = 0;
    let totalQuantity = 0;

    // Sort users by username
    const sortedUsers = Array.from(userWants.entries()).sort(([,a], [,b]) => 
        a.username.localeCompare(b.username)
    );

    for (const [userId, userData] of sortedUsers) {
        if (userData.cards.size === 0) continue;

        // Group cards by name, then show different specifications
        const cardGroups = new Map();
        
        for (const [cardKey, quantity] of userData.cards.entries()) {
            const keyInfo = parseCardKey(cardKey);
            
            if (!cardGroups.has(keyInfo.cardName)) {
                cardGroups.set(keyInfo.cardName, []);
            }
            
            cardGroups.get(keyInfo.cardName).push({
                setCode: keyInfo.setCode,
                foil: keyInfo.foil,
                quantity: quantity
            });
        }

        const cardLines = [];
        for (const [cardName, specs] of cardGroups.entries()) {
            // Sort specs by set, then by foil
            specs.sort((a, b) => {
                if (a.setCode !== b.setCode) {
                    if (!a.setCode) return 1;
                    if (!b.setCode) return -1;
                    return a.setCode.localeCompare(b.setCode);
                }
                return a.foil - b.foil;
            });
            
            for (const spec of specs) {
                const display = formatCardDisplay(cardName, spec.setCode, spec.foil);
                cardLines.push(`• ${spec.quantity}x ${display}`);
                totalQuantity += spec.quantity;
            }
        }

        cardLines.sort();
        const cardList = cardLines.join('\n');

        description += `**${userData.username}:**\n${cardList}\n\n`;
        totalSpecs += userData.cards.size;
    }

    if (description) {
        // Truncate description if too long for Discord embed limit
        if (description.length > 4000) {
            description = description.substring(0, 3900) + '\n\n*...list truncated due to length*';
        }
        
        embed.setDescription(description.trim());
        embed.setFooter({ 
            text: `${totalSpecs} card specifications (${totalQuantity} total copies) | Powered by Scryfall API` 
        });
    } else {
        embed.setDescription('*No cards wanted yet. Use `/wants + [number] [card name]` to add cards!*');
    }

    return embed;
}

async function showHelp(interaction) {
    const embed = new EmbedBuilder()
        .setTitle('🎴 MTG Wants Bot Commands')
        .setColor(0x7289DA)
        .addFields(
            {
                name: '➕ Add Cards',
                value: '`/wants + [number] [card name]`\n`/wants + [number] [card name] ([set])`\n`/wants + [number] [card name] ([set], foil)`\n`/wants + [number] [card name] (foil)`\n\nExamples:\n`/wants + 2 Lightning Bolt`\n`/wants + 1 Lightning Bolt (M25, foil)`\n`/wants + 3 Lightning Bolt (foil)`',
                inline: false
            },
            {
                name: '➖ Remove Cards',
                value: '`/wants - [number] [card name]`\nSame format as adding. Examples:\n`/wants - 1 Lightning Bolt (M25, foil)`\n`/wants - 2 Lightning Bolt`',
                inline: false
            },
            {
                name: '🔄 Multiple Operations',
                value: 'Combine multiple operations in one command:\n`/wants +1 Lightning Bolt (M25, foil) -2 Opt +4 Island`\n`/wants +2 Force of Will (foil) -1 Brainstorm (EMA)`',
                inline: false
            },
            {
                name: '🗑️ Clear All Cards',
                value: '`/wants clear`\nRemoves all cards from your wants list',
                inline: false
            },
            {
                name: '📋 Set Specifications',
                value: 'You can specify sets by:\n• **Set code**: `(M25)`, `(EMA)`, `(2XM)`\n• **Set name**: `(Masters 25)`, `(Eternal Masters)`\n• **Mixed**: `(Masters 25, foil)` or `(M25, foil)`\n• **Foil only**: `(foil)`',
                inline: false
            },
            {
                name: '🔍 How it works',
                value: 'The bot validates all card names and sets using the Scryfall API. Card names are fuzzy-matched, so "bolt" will find "Lightning Bolt". Each different combination of card/set/foil is tracked separately.\n\nYou can want up to 50 different card specifications, 99 copies each.',
                inline: false
            }
        )
        .setFooter({ text: 'Powered by Scryfall API | The wants list appears as a pinned message in this channel' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showHelpLegacy(message) {
    const embed = new EmbedBuilder()
        .setTitle('🎴 MTG Wants Bot Commands')
        .setColor(0x7289DA)
        .addFields(
            {
                name: '➕ Add Cards',
                value: '`!wants + [number] [card name]`\n`!wants + [number] [card name] ([set])`\n`!wants + [number] [card name] ([set], foil)`\n`!wants + [number] [card name] (foil)`\n\nExamples:\n`!wants + 2 Lightning Bolt`\n`!wants + 1 Lightning Bolt (M25, foil)`\n`!wants + 3 Lightning Bolt (foil)`',
                inline: false
            },
            {
                name: '➖ Remove Cards',
                value: '`!wants - [number] [card name]`\nSame format as adding. Examples:\n`!wants - 1 Lightning Bolt (M25, foil)`\n`!wants - 2 Lightning Bolt`',
                inline: false
            },
            {
                name: '🔄 Multiple Operations',
                value: 'Combine multiple operations in one command:\n`!wants +1 Lightning Bolt (M25, foil) -2 Opt +4 Island`\n`!wants +2 Force of Will (foil) -1 Brainstorm (EMA)`',
                inline: false
            },
            {
                name: '🗑️ Clear All Cards',
                value: '`!wants clear`\nRemoves all cards from your wants list',
                inline: false
            },
            {
                name: '📋 Set Specifications',
                value: 'You can specify sets by:\n• **Set code**: `(M25)`, `(EMA)`, `(2XM)`\n• **Set name**: `(Masters 25)`, `(Eternal Masters)`\n• **Mixed**: `(Masters 25, foil)` or `(M25, foil)`\n• **Foil only**: `(foil)`',
                inline: false
            },
            {
                name: '🔍 How it works',
                value: 'The bot validates all card names and sets using the Scryfall API. Card names are fuzzy-matched. Each different combination of card/set/foil is tracked separately.',
                inline: false
            }
        )
        .setFooter({ text: 'Powered by Scryfall API | The wants list will appear as a pinned message in this channel' });

    await message.reply({ embeds: [embed] });
}

// Login with your bot token
const token = process.env.BOT_TOKEN;
client.login(token);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down bot...');
    client.destroy();
    process.exit(0);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});
