import express from "express";
import bodyParser from "body-parser";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import puppeteer from "puppeteer";
import Handlebars from "handlebars";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
app.use(bodyParser.json());

// Function to print PDF using system printer
async function printPDF(filePath, printerName) {
  try {
    // Check if running in serverless environment by checking for /tmp directory
    const isServerless = !fs.existsSync("/tmp");

    if (isServerless) {
      console.log(
        "Running in serverless environment - printing is not supported"
      );
      return {
        success: false,
        message:
          "Printing is not supported in serverless environment. Please download the PDF and print locally.",
        filePath: filePath,
      };
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return {
        success: false,
        message: `File not found: ${filePath}`,
      };
    }

    const platform = os.platform();
    let command;

    if (platform === "darwin" || platform === "linux") {
      // macOS or Linux
      command = `lp -d "${printerName}" "${filePath}"`;
    } else if (platform === "win32") {
      // Windows
      // Use PowerShell to print (better Unicode & PDF support than legacy PRINT)
      command = `powershell -Command "Start-Process -FilePath '${filePath}' -Verb Print -PassThru | Out-Null"`;
    } else {
      console.error(`Unsupported platform: ${platform}`);
      return {
        success: false,
        message: `Unsupported platform: ${platform}`,
      };
    }

    console.log("Executing print command:", command);
    const { stdout, stderr } = await execAsync(command);

    if (stderr) {
      console.error("Printing error:", stderr);
      return {
        success: false,
        message: `Printing error: ${stderr}`,
      };
    }

    console.log("Print job submitted successfully:", stdout);

    // Optional: Print queue (macOS/Linux only)
    if (platform === "darwin" || platform === "linux") {
      const { stdout: queueOutput } = await execAsync("lpq");
      console.log("Current print queue:", queueOutput);
    }

    return {
      success: true,
      message: "Print job submitted successfully",
      filePath: filePath,
    };
  } catch (error) {
    console.error("Printing error:", error);
    return {
      success: false,
      message: `Printing error: ${error.message}`,
      filePath: filePath,
    };
  }
}

// Function to generate PDF with retry logic
async function generatePDF(templateData, maxRetries = 3) {
  let browser = null;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      const template = fs.readFileSync(
        path.join(__dirname, "templates", "receipt.html"),
        "utf-8"
      );
      const compiledTemplate = Handlebars.compile(template);
      const html = compiledTemplate(templateData);

      // More stable Puppeteer configuration
      browser = await puppeteer.launch({
        headless: true,
        executablePath:
          process.platform === "darwin"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-extensions",
        ],
        ignoreHTTPSErrors: true,
        timeout: 60000,
      });

      const page = await browser.newPage();

      // Set viewport and content
      await page.setViewport({ width: 800, height: 600 });
      await page.setContent(html, {
        waitUntil: ["load", "networkidle0"],
        timeout: 60000,
      });

      // Generate PDF buffer instead of saving to file
      const pdfBuffer = await page.pdf({
        width: "80mm",
        printBackground: true,
        margin: {
          top: "5mm",
          right: "5mm",
          bottom: "5mm",
          left: "5mm",
        },
        timeout: 60000,
        preferCSSPageSize: true,
      });

      console.log("PDF generated successfully in memory");
      return pdfBuffer;
    } catch (error) {
      console.error(`PDF generation attempt ${retryCount + 1} failed:`, error);
      retryCount++;

      if (retryCount === maxRetries) {
        throw new Error(
          `Failed to generate PDF after ${maxRetries} attempts: ${error.message}`
        );
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error("Error closing browser:", closeError);
        }
      }
    }
  }
}

// Function to print PDF buffer directly
async function printPDFBuffer(pdfBuffer, printerName) {
  try {
    // Check if running in serverless environment
    const isServerless = !fs.existsSync("/tmp");

    if (isServerless) {
      console.log(
        "Running in serverless environment - printing is not supported"
      );
      return {
        success: false,
        message: "Printing is not supported in serverless environment.",
      };
    }

    const platform = os.platform();
    let command;

    // Create a temporary file to print
    const tempFile = path.join(os.tmpdir(), `temp-print-${Date.now()}.pdf`);
    fs.writeFileSync(tempFile, pdfBuffer);

    if (platform === "darwin" || platform === "linux") {
      command = `lp -d "${printerName}" "${tempFile}"`;
    } else if (platform === "win32") {
      command = `powershell -Command "Start-Process -FilePath '${tempFile}' -Verb Print -PassThru | Out-Null"`;
    } else {
      console.error(`Unsupported platform: ${platform}`);
      return {
        success: false,
        message: `Unsupported platform: ${platform}`,
      };
    }

    console.log("Executing print command:", command);
    const { stdout, stderr } = await execAsync(command);

    // Clean up temporary file
    try {
      fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      console.error("Error cleaning up temporary file:", cleanupError);
    }

    if (stderr) {
      console.error("Printing error:", stderr);
      return {
        success: false,
        message: `Printing error: ${stderr}`,
      };
    }

    console.log("Print job submitted successfully:", stdout);
    return {
      success: true,
      message: "Print job submitted successfully",
    };
  } catch (error) {
    console.error("Printing error:", error);
    return {
      success: false,
      message: `Printing error: ${error.message}`,
    };
  }
}

// Add GET endpoint for health check and testing
app.get("/api/printing", (req, res) => {
  res.json({
    status: "ok",
    message: "Printing service is running",
    endpoints: {
      POST: "/api/printing - Generate and print invoice",
      GET: "/api/printing - Service status check",
    },
  });
});

app.post("/api/printing", async (req, res) => {
  try {
    const { invoiceId, customerName, items, status, printName } = req.body;

    // Calculate subtotals for items
    const itemsWithSubtotals = items.map((item) => {
      const price =
        typeof item.price === "string" && item.price !== "0.00"
          ? parseFloat(item.price.replace(/[^0-9.-]+/g, ""))
          : parseFloat(item.price) || 0;

      const quantity = parseInt(item.quantity) || 0;
      const subtotal = quantity * price;

      return {
        ...item,
        price: price.toFixed(2),
        quantity: quantity.toString(),
        subtotal: subtotal.toFixed(2),
      };
    });

    const calculatedTotal = itemsWithSubtotals
      .reduce((sum, item) => sum + parseFloat(item.subtotal), 0)
      .toFixed(2);

    const templateData = {
      invoiceId,
      customerName,
      items: itemsWithSubtotals,
      total: calculatedTotal,
      date: new Date().toLocaleDateString(),
    };

    console.log("Generating PDF...");
    const pdfBuffer = await generatePDF(templateData);
    console.log("PDF generated successfully in memory");

    // Auto print if requested
    let printResult = null;
    if (status) {
      console.log("Auto-print requested, sending to printer...");
      printResult = await printPDFBuffer(pdfBuffer, printName);
      console.log("Print status:", printResult);
    }

    res.json({
      success: true,
      printResult: printResult,
      message: printResult?.message || "PDF generated successfully",
    });
  } catch (error) {
    console.error("Error in print-invoice:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Local print server on port ${PORT}`));
