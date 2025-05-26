async function printPDF(filePath) {
  try {
    const printerName = "HP_Laser_MFP_131_133_135_138";

    // Ensure the file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return false;
    }

    // Use lp command for better queue management
    const command = `lp -d "${printerName}" "${filePath}"`;
    console.log("Executing print command:", command);

    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.error("Printing error:", stderr);
      return false;
    }

    // Extract job ID from lp output
    const jobId = stdout.match(/request id is ([^\s]+)/)?.[1];
    console.log("Print job submitted successfully. Job ID:", jobId);

    // Check print queue
    const { stdout: queueOutput } = await execAsync("lpq");
    console.log("Current print queue:", queueOutput);

    return true;
  } catch (error) {
    console.error("Printing error:", error);
    return false;
  }
}