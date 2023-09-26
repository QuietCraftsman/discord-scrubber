import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';

import axios from 'axios';
import csvParser from 'csv-parser';
import inquirer from 'inquirer';
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./deletions.db', (error) => {
    if (error) {
        console.error(error.message);
    }
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
});

const recordDeletion = (channelId, messageId) => {
    db.run(`INSERT INTO deleted_messages(
        channel_id,
        message_id
    ) VALUES(?, ?)`, [channelId, messageId], (error) => {
        if (error) {
            console.error(error.message);
        }

        //console.log('Table created.');
    });
};

const isMessageDeleted = (channelId, messageId, callback) => {
    db.get(`SELECT message_id FROM deleted_messages
    WHERE channel_id = ? AND message_id = ?`, [channelId, messageId], (error, row) => {
        if (error) {
            callback(error, null);
        } else if (row) {
            callback(null, true);   // Message was previously deleted.
        } else {
            callback(null, false);  // Message was not deleted.
        }
    });
};

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
        // Verify if the message has been previously deleted.
        const wasDeleted = await new Promise((resolve) => {
            isMessageDeleted(selectedChannel, message.value, (error, result) => {
                if (error) {
                    console.error(error.message);
                    resolve(true);  // To avoid re-deleting on error, "assume" it was deleted.
                } else {
                    resolve(result);
                }
            });
        });

        if (wasDeleted) {
            console.log(`Skipping deletion for previously deleted message with ID: ${message.value}`);
            continue;   // Skip to the next iteration if the message was previously deleted.
        }

        let retry = false;
        let retryCount = 0;
        const maxRetries = 5;

        do {
            const channelId = selectedChannel.substring(1); // Remove the 'c' prefix.
            const response = await deleteRequest(channelId, message.value);

            if (response.status === 429) {
                console.log(`Rate limited! Waiting for ${response.headers['Retry-After']} seconds.`);

                await new Promise((resolve) => {
                    setTimeout(resolve, parseFloat(response.headers['Retry-After']) * 1000)
                });

                // Retry this message after waiting.
                retryCount++;
                retry = retryCount < maxRetries;
            } else if (response.status !== 204 && response.status !== 200) {
                console.error(`Failed to delete message with ID: ${message.value}. Status code: ${response.status}. Reason: ${JSON.stringify(response.data)}`);

                // No retry in case of a non-rate-limit error, but you can add logic here if needed.
                retry = false;
            } else {
                console.log(`Deleted message with ID: ${message.value}`);

                // Record the deletion to the database.
                recordDeletion(selectedChannel, message.value);

                retry = false;

                // Ensure there's at least 2500 ms between requests.
                await new Promise((resolve) => {
                    setTimeout(resolve, 2500);
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

const deleteRequest = async (channelId, messageId) => {
    try {
        const response = await axios.delete(`https://discord.com/api/v9/channels/${channelId}/messages/${messageId}`, {
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8',
                'Authorization': `${global.accessToken}`,
                'Origin': 'https://discord.com',
                //'Referer': `https://discord.com/channels/@me/${channelId}`
            }
        });

        if (response.status === 204) { // 204 is the HTTP status code for 'No Content', which is typical for DELETE requests
            return {
                status: 204
            };
        } else {
            throw new Error(`Unexpected status code: ${response.status}`);
        }
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code outside of the range of 2xx.

            // Uh oh, we got throttled.
            if (error.response.status == 429) {
                return {
                    status: 429,
                    headers: {
                        'Retry-After': error.response.headers['retry-after'] || 5
                    },
                    data: error.response.data
                };
            } else {
                // Log the error and decide what to do
                console.error(`Error for message ${messageId} in channel ${channelId}`);
                console.error(`Status code: ${error.response.status}`);
                console.error(`Error response: ${JSON.stringify(error.response.data)}`);

                // For now, let's return an object with status and data so we can decide later
                return {
                    status: error.response.status,
                    data: error.response.data
                };
            }
        } else if (error.request) {
            // The request was made but no response was received.
            console.log(`No response received: ${error.request}`);

            return {
                status: 500,
                data: 'No response received from the server.'
            };
        } else {
            // Some other error occurred.
            console.log(`Error: ${error.message}`);

            return {
                status: 500,
                data: error.message
            }
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