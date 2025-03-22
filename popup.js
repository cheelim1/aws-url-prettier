function cleanAWSUrl(url) {
   try {
     const parsedUrl = new URL(url);
     const hostnameParts = parsedUrl.hostname.split(".");
     // AWS console URLs normally follow:
     // region.console.aws.amazon.com  (i.e., 5 parts)
     // When multi-session is enabled, you get an extra subdomain:
     // dynamicValue.region.console.aws.amazon.com (i.e., 6 parts)
     if (hostnameParts.length === 6) {
       // Remove the first part (the dynamic account/session info)
       hostnameParts.shift();
       parsedUrl.hostname = hostnameParts.join(".");
     }
     return parsedUrl.toString();
   } catch (err) {
     console.error("Invalid URL provided", err);
     return url;
   }
 }
 
 function updatePopup() {
   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
     if (tabs.length === 0) return;
 
     const currentTab = tabs[0];
     const originalUrl = currentTab.url;
     const cleanUrl = cleanAWSUrl(originalUrl);
 
     const urlDisplay = document.getElementById("urlDisplay");
     const copyBtn = document.getElementById("copyBtn");
     const showFullBtn = document.getElementById("showFullBtn");
 
     // Truncate if the URL is too long
     const maxLength = 150; 
     let truncatedUrl = cleanUrl;
     if (cleanUrl.length > maxLength) {
       truncatedUrl = 
         cleanUrl.slice(0, 70) + 
         "..." + 
         cleanUrl.slice(-40); // Show the first 70 & last 40
       urlDisplay.textContent = truncatedUrl;
       showFullBtn.style.display = "inline-block"; // Show the button
       showFullBtn.textContent = "Show Full";
 
       // Toggle between truncated & full text on click
       showFullBtn.addEventListener("click", () => {
         if (urlDisplay.textContent === truncatedUrl) {
           // Currently showing truncated, switch to full
           urlDisplay.textContent = cleanUrl;
           showFullBtn.textContent = "Show Less";
         } else {
           // Switch back to truncated
           urlDisplay.textContent = truncatedUrl;
           showFullBtn.textContent = "Show Full";
         }
       });
     } else {
       // If not too long, just display full URL
       urlDisplay.textContent = cleanUrl;
     }
 
     copyBtn.addEventListener("click", () => {
       navigator.clipboard.writeText(cleanUrl).then(() => {
         copyBtn.textContent = "Copied!";
         setTimeout(() => {
           copyBtn.textContent = "Copy Updated URL";
         }, 2000);
       }).catch((err) => {
         console.error("Failed to copy text: ", err);
       });
     });
   });
 }
 
 document.addEventListener("DOMContentLoaded", updatePopup);
 