import express from "express";
import bodyParser from "body-parser";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";
import Handlebars from "handlebars";
import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
app.use(bodyParser.json());

// PrintNode API configuration
const PRINTNODE_API_KEY = "rewYAYdtAjYhpk5GkwQclkG3nLViC9dulNDb3Mo3WE8";
const PRINTNODE_API_URL = "https://api.printnode.com";

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
      // Create a new PDF document with A4 size
      const doc = new PDFDocument({
        size: "A4", // A4 size (210mm x 297mm)
        margin: 50, // Increased margin for A4
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

      // Add content to PDF with improved layout for A4
      doc.fontSize(24);
      doc.text("Invoice", { align: "center" });
      doc.moveDown();

      // Add invoice details with better spacing
      doc.fontSize(12);
      doc.text(`Invoice ID: ${templateData.invoiceId}`);
      doc.text(`Customer: ${templateData.customerName}`);
      doc.text(`Date: ${templateData.date}`);
      doc.moveDown(2);

      // Add items table header with better formatting
      doc.fontSize(14);
      doc.text("Items:", { underline: true });
      doc.moveDown();

      // Add items with better formatting
      doc.fontSize(12);
      templateData.items.forEach((item) => {
        doc
          .text(`${item.name}`, { continued: true, width: 300 })
          .text(`x ${item.quantity}`, {
            continued: true,
            width: 100,
            align: "center",
          })
          .text(`$${item.subtotal}`, { align: "right" });
      });

      doc.moveDown(2);
      doc.fontSize(14);
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
async function printPDFBuffer(pdfBuffer, printerId) {
  try {
    if (!PRINTNODE_API_KEY) {
      throw new Error("PrintNode API key is not configured");
    }

    // Convert PDF buffer to base64
    const base64PDF = pdfBuffer.toString("base64");

    // Prepare print job
    const printJob = {
      printerId: printerId,
      title: `Invoice-${Date.now()}`,
      contentType: "pdf_base64",
      content: base64PDF,
      source: "Invoice Generator",
      options: {
        media: "Custom.80x297mm", // 80mm receipt paper
        n: 1, // Number of copies
      },
    };

    // Send print job to PrintNode
    const response = await axios.post(
      `${PRINTNODE_API_URL}/printjobs`,
      printJob,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(PRINTNODE_API_KEY + ":").toString(
            "base64"
          )}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Print job submitted successfully:", response.data);
    return {
      success: true,
      message: "Print job submitted successfully",
      jobId: response.data.id,
    };
  } catch (error) {
    console.error("PrintNode error:", error.response?.data || error.message);
    return {
      success: false,
      message: `Printing error: ${
        error.response?.data?.message || error.message
      }`,
    };
  }
}

// Function to get available printers from PrintNode
async function getPrinters() {
  try {
    if (!PRINTNODE_API_KEY) {
      throw new Error("PrintNode API key is not configured");
    }

    const response = await axios.get(`${PRINTNODE_API_URL}/printers`, {
      headers: {
        Authorization: `Basic ${Buffer.from(PRINTNODE_API_KEY + ":").toString(
          "base64"
        )}`,
        "Content-Type": "application/json",
      },
    });

    return response.data;
  } catch (error) {
    console.error(
      "Error fetching printers:",
      error.response?.data || error.message
    );
    throw error;
  }
}

// Add endpoint to get available printers
app.get("/api/printers", async (req, res) => {
  try {
    const printers = await getPrinters();
    res.json({
      success: true,
      printers: printers,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/printing", async (req, res) => {
  try {
    const { invoiceId, customerName, items, printerId } = req.body;

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

    // Print using PrintNode if requested
    let printResult = null;
    if (printerId) {
      console.log("Auto-print requested, sending to PrintNode...");
      printResult = await printPDFBuffer(pdfBuffer, printerId);
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
