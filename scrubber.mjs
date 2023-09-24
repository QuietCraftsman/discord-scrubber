import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';

import csvParser from 'csv-parser';
import inquirer from 'inquirer';


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
        // console.log(`Selected: ${selectedChannel}`);
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
            } else {
                // For now, we just print the selected message ID, but you can expand this section
                // to display more details or provide further options.
                console.log(`Selected Message ID: ${selectedMessage}`);
                await displayMessages(selectedChannel, dataDumpPath, indexData, subdirectories); // Return to message list
            }
        });
};

// Start the script by prompting the user for the data dump path.
inquirer.prompt([
    {
        type: 'input',
        name: 'dataDumpPath',
        message: 'Path to Discord data dump?',
        validate: (input) => input ? true : "Path cannot be empty!"
    }
]).then(async (answers) => {
    await crawlDataDump(answers.dataDumpPath);
});

// Print out the testing output.
// for (const subdirectory of subdirectories) {
//     const channelId = subdirectory.slice(1); // Remove the 'c' prefix to get the channel ID
//     const channelName = indexData[channelId] || ""; // Fetch name from index or default to empty string

//     console.log(`${subdirectory}: ${channelName}`);
// }