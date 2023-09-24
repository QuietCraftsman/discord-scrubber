import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import { createInterface } from 'node:readline';

const reader = createInterface({
    input: process.stdin,
    output: process.stdout
});

reader.question("Path to Discord data dump? ", (answer) => {
    if (!answer) {
        console.error("Path cannot be empty!");
        reader.close();
        exit(1);
    }

    crawlDataDump(answer);
    reader.close();
});

const crawlDataDump = (dataDumpPath) => {
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

    // Print out the testing output.
    for (const subdirectory of subdirectories) {
        const channelId = subdirectory.slice(1); // Remove the 'c' prefix to get the channel ID
        const channelName = indexData[channelId] || ""; // Fetch name from index or default to empty string

        console.log(`${subdirectory}: ${channelName}`);
    }
}