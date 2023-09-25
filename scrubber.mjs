import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';

import csvParser from 'csv-parser';
import inquirer from 'inquirer';
import sqlite3 from 'sqlite3';


const db = new sqlite3.Database('./deletions.db', (error) => {
    if (error) {
        console.error(error.message);
    }

    console.log('Connected to the deletions database.');
});

// Create the table.
db.run(`CREATE TABLE IF NOT EXISTS deleted_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL
)`, (error) => {
    if (error) {
        console.error(error.message);
    }

    console.log('Table created.');
});

const channelId = 'CHANNEL_ID';
const messageId = 'MESSAGE_ID';
const apiUrl = `https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`;

const crawlDataDump = async (dataDumpPath) => {
    // Read the index.json from the messages directory.
    const indexPath = join(dataDumpPath, 'messages', 'index.json');

    // Check if the file exists. If not, exit.
    if (!existsSync(indexPath)) {
        console.error('index.json not found in the specified directory.');
        exit(1);
    }

    // Parse the index.json.
    const indexData = JSON.parse(readFileSync(indexPath, 'utf-8'));

    // Iterate through the subdirectories.
    const messageDirectory = join(dataDumpPath, 'messages');
    const subdirectories = readdirSync(messageDirectory).filter((subdirectory) => {
        // Check if it's a directory with a 'c' prefix.
        const fullSubdirectoryPath = join(messageDirectory, subdirectory);
        return subdirectory.startsWith('c') && statSync(fullSubdirectoryPath).isDirectory();
    });

    await displayChannelList(dataDumpPath, indexData, subdirectories);
};

const displayChannelList = async (dataDumpPath, indexData, subdirectories) => {
    const choices = subdirectories.map((subdirectory) => {
        const channelId = subdirectory.slice(1);
        const channelName = indexData.hasOwnProperty(channelId) ? indexData[channelId] : "NOT FOUND IN INDEX";

        return {
            name: `${subdirectory}: ${channelName}`,
            value: subdirectory
        };
    });

    choices.push(new inquirer.Separator());
    choices.push({
        name: "Exit",
        value: "exit"
    });

    const { selectedChannel } = await inquirer.prompt([
        {
            type: 'list',
            name: 'selectedChannel',
            message: 'Select a channel:',
            choices: choices
        }
    ]);

    if (selectedChannel === "exit") {
        exit(0);
    } else {
        // Display messages or further navigation for the selected channel
        await displayMessages(selectedChannel, dataDumpPath, indexData, subdirectories);
    }
};

const displayMessages = async (selectedChannel, dataDumpPath, indexData, subdirectories) => {
    const csvPath = join(dataDumpPath, 'messages', selectedChannel, 'messages.csv');

    if (!existsSync(csvPath)) {
        console.error('messages.csv not found for the selected channel.');

        await displayChannelList(dataDumpPath, indexData, subdirectories);  // Return to channel listing.
        return;
    }

    const messages = [];

    createReadStream(csvPath)
        .pipe(csvParser())
        .on('data', (row) => {
            // Extract ID and Contents only.
            messages.push({
                name: `${row.ID}: ${row.Contents}`,
                value: row.ID
            });
        })
        .on('end', async () => {
            messages.push(new inquirer.Separator());
            messages.push({
                name: "Delete messages",
                value: "delete_messages"
            });
            messages.push({
                name: "Back to Channel List",
                value: "back_to_list"
            });

            const { selectedMessage } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selectedMessage',
                    message: 'Select a message:',
                    choices: messages,
                    pageSize: 15
                }
            ]);

            if (selectedMessage === "back_to_list") {
                await displayChannelList(dataDumpPath, indexData, subdirectories);
            } else if (selectedMessage === "delete_messages") {
                await deleteMessages(selectedChannel, messages, dataDumpPath, indexData, subdirectories);
            } else {
                console.log(`Selected Message ID: ${selectedMessage}`);
                await displayMessages(selectedChannel, dataDumpPath, indexData, subdirectories); // Return to message list
            }
        });
};

const deleteMessages = async (selectedChannel, messages, dataDumpPath, indexData, subdirectories) => {
    const validMessages = messages.filter((message) => {
        return message.value &&
            typeof message.value === 'string' &&
            !["back_to_list", "delete_messages"].includes(message.value)
    });


    for (const message of validMessages) {
        let retry = false;

        do {
            const response = await mockDeleteRequest(message.value);

            if (response.status === 429) {
                console.log(`Rate limited! Waiting for ${response.headers['Retry-After']} seconds.`);

                await new Promise((resolve) => {
                    setTimeout(resolve, parseFloat(response.headers['Retry-After']) * 1000)
                });

                // Retry this message after waiting.
                retry = true;
            } else {
                console.log(`Deleted message with ID: ${message.value}`);

                retry = false;

                // Ensure there's at least 250 ms between requests.
                await new Promise((resolve) => {
                    setTimeout(resolve, 250);
                });
            }
        } while (retry); // Keep retrying the current message until it succeeds.
    }

    // Remove the processed channel from the subdirs list.
    const index = subdirectories.indexOf(selectedChannel);

    if (index > -1) {
        subdirectories.splice(index, 1);
    }

    // Return to channel listing after a successful completion.
    await displayChannelList(dataDumpPath, indexData, subdirectories);
}

const mockDeleteRequest = async (messageId) => {
    // This function mimics the behavior of the Discord API.
    // To be replaced with actual HTTP DELETE requests.

    // Here, we randomly decide whether to simulate a rate limit.
    if (Math.random() < 0.1) {  // 10% flat chance of a rate limit demonstration.
        return {
            status: 429,
            headers: {
                'X-RateLimit-Global': false,
                'Retry-After': (Math.random() * 5).toFixed(2)  // Random wait time between 0 and 5 seconds
            },
            body: {
                "message": "You are being rate limited.",
                "retry_after": (Math.random() * 5).toFixed(2),
                "global": false
            }
        };
    } else {
        return {
            status: 204 // No content
            // NOTE: Look into the browser calls. Do we get 200 or some other code?
        }
    }
}

// Start the script by prompting the user for the data dump path.
inquirer.prompt([
    {
        type: 'input',
        name: 'dataDumpPath',
        message: 'Path to Discord data dump?',
        validate: (input) => input ? true : "Path cannot be empty!"
    },
    {
        type: 'password',   // To hide the token when being entered
        name: 'accessToken',
        message: 'Please enter a valid access token:',
        validate: (input) => input ? true : "Access token cannot be empty!"
    }
]).then(async (answers) => {
    global.accessToken = answers.accessToken;   // Store the token globally for later
    await crawlDataDump(answers.dataDumpPath);
});