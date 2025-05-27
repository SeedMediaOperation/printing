import express from "express";
import bodyParser from "body-parser";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";
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

// Function to generate PDF
async function generatePDF(templateData) {
  return new Promise((resolve, reject) => {
    try {
      // Create a new PDF document
      const doc = new PDFDocument({
        size: [226.77, 800], // 80mm width in points (80mm * 2.83465 points/mm)
        margin: 10,
        autoFirstPage: true,
      });

      // Create chunks array to store PDF data
      const chunks = [];

      // Collect PDF data chunks
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        // Combine chunks into a single buffer
        const pdfBuffer = Buffer.concat(chunks);
        resolve(pdfBuffer);
      });

      // Add content to PDF
      doc.fontSize(12);
      doc.text("Invoice", { align: "center" });
      doc.moveDown();

      // Add invoice details
      doc.fontSize(10);
      doc.text(`Invoice ID: ${templateData.invoiceId}`);
      doc.text(`Customer: ${templateData.customerName}`);
      doc.text(`Date: ${templateData.date}`);
      doc.moveDown();

      // Add items table header
      doc.text("Items:", { underline: true });
      doc.moveDown(0.5);

      // Add items
      templateData.items.forEach((item) => {
        doc.text(`${item.name} x ${item.quantity} = $${item.subtotal}`);
      });

      doc.moveDown();
      doc.text(`Total: $${templateData.total}`, { align: "right" });

      // Finalize PDF
      doc.end();
    } catch (error) {
      console.error("Error in PDF generation:", error);
      reject(error);
    }
  });
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

    if (platform === "darwin") {
      // macOS
      command = `lpr -P "${printerName}" "${tempFile}"`;
    } else if (platform === "linux") {
      // Linux
      command = `lp -d "${printerName}" "${tempFile}"`;
    } else if (platform === "win32") {
      // Windows
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
