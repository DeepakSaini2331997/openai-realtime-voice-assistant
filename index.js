import Fastify from "fastify"
import WebSocket from "ws"
import fastifyFormbody from "@fastify/formbody"
import fastifyWs from "@fastify/websocket"
import dotenv from "dotenv"
dotenv.config()

const { OPENAI_API_KEY } = process.env
if(!OPENAI_API_KEY){
    console.error("Missing OpenAI API key!")
    process.exit(1)
}

const fastify = Fastify();
fastify.register(fastifyFormbody)
fastify.register(fastifyWs)

const SYSTEM_MESSAGE = 'you are an helpful ai assitant for a car garage named goCar and your main goal is to help the user book appointment for their car repair or service. do not haluinate';
const VOICE = 'alloy'
const PORT = process.env.PORT || 5050


fastify.get('/',async (req,res)=>{
    res.send({message:"Twilio Media server is connect"})
})

fastify.all('/incoming-call',async(req,res)=>{
    console.log('Incoming call');
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Please wait while we connect your call to the AI. Hi, you have called Bart's Automative Centre. How can we help?</Say>
                              <Pause lenth="1" />
                              <Connect>
                                  <Stream url="wss://${req.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    res.type('text/xml').send(twimlResponse);
})

fastify.register(async(fastify)=>{
    fastify.get('/media-stream',{websocket:true},(connection,req)=>{
        console.log("Client Connect..")
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-06', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
              type: "session.update",
              session: {
                turn_detection: { type: "server_vad" },
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                voice: VOICE,
                instructions: SYSTEM_MESSAGE,
                modalities: ["text","audio"],
                temperature: 0.8,
                tools: [
                  {
                    type: "function",
                    name: "sheduleAppointment",
                    description:
                      "Helps user book/shedule an appointment with the garage for car repair/service example prompt: i want to book and appointment for car service",
                    parameters: {
                      type: "object",
                      properties: {
                        date: { type: "string" },
                        email: { type: "string" },
                        name: { type: "string" },
                      },
                      required: ["date", "email", "name"],
                    },
                  },
                  {
                    type: "function",
                    name: "endConversation",
                    description:
                      "ends the conversation once the user query/task is done",
                    parameters: {},
                  },
                ],
              },
            };
      
            openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["text","audio"],
                  instructions:
                    "Greet the user by saying welcome to Go Car and ask them how can you help",
                },
              })
            );
      
            openAiWs.send(JSON.stringify(sessionUpdate));
          };

        // Open event for OpenAI WebSocket
        openAiWs.on("open", () => {
            console.log("Connected to the OpenAI Realtime API");
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on("message", (data) => {
            try {
            const response = JSON.parse(data);
    
            if (response.type === "response.function_call_arguments.done") {
                console.log("function call success", response);
                let argument = JSON.parse(response.arguments);
    
                if (response.name === "sheduleAppointment") {
                try {
                    console.log(`called sheduleAppointment ${argument}`);
                    openAiWs.send(
                    JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                        type: "function_call_output",
                        output: `the appointment is sheduled`,
                        },
                    })
                    );
    
                    //immediately respond to user.
                    openAiWs.send(
                    JSON.stringify({
                        type: "response.create",
                        response: {
                        modalities: ["text","audio"],
                        instructions: `tell the user your: Hi ${argument.name} your appointment for ${argument.date} is sheduled, you will recive a confirmation mail on ${argument.email}`,
                        },
                    })
                    );
                } catch (error) {
                    console.error(`Error processing function call: ${error}`);
                }
                }
    
                if (response.name === "endConversation") {
                try {
                    openAiWs.send(
                    JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                        type: "function_call_output",
                        output: "the query is resolved",
                        },
                    })
                    );
    
                    //immediately respond to user.
                    openAiWs.send(
                    JSON.stringify({
                        type: "response.create",
                        response: {
                        modalities: ["text", "audio"],
                        instructions: `thank the user and wish them a nice day ahead`,
                        },
                    })
                    );
    
                    if (
                    openAiWs &&
                    openAiWs.readyState === WebSocket.OPEN &&
                    connection &&
                    connection.readyState === WebSocket.OPEN
                    ) {
                    openAiWs.close();
                    connection.close();
                    console.log("Manually closed the Twilio WebSocket");
                    console.log("Manually closed the OpenAI WebSocket");
                    }
                } catch (error) {
                    console.error(`Error processing function call: ${error}`);
                }
                }
            }
    
            if (response.type === "response.audio.delta" && response.delta) {
                const audioDelta = {
                event: "media",
                streamSid: streamSid,
                media: {
                    payload: Buffer.from(response.delta, "base64").toString("base64"),
                },
                };
                connection.send(JSON.stringify(audioDelta));
            }
            } catch (error) {
            console.error("Error processing OpenAI message:", error);
            }
        });
  
        // Handle incoming messages from Twilio
        connection.on("message", (message) => {
            try {
            const data = JSON.parse(message);
            switch (data.event) {
                case "media":
                if (openAiWs.readyState === WebSocket.OPEN) {
                    const audioAppend = {
                    type: "input_audio_buffer.append",
                    audio: data.media.payload,
                    };
                    openAiWs.send(JSON.stringify(audioAppend));
                }
                break;
                case "start":
                streamSid = data.start.streamSid;
                console.log("Incoming stream has started");
                break;
                default:
                console.log("Received non-media event:");
                break;
            }
            } catch (error) {
            console.error("Error parsing message:", error, "Message:", message);
            }
        });
  
        // Handle connection close
        connection.on("close", () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log("Client disconnected.");
        });
  
        // Handle WebSocket close and errors
        openAiWs.on("close", () => {
            console.log("Disconnected from the OpenAI Realtime API");
        });
  
        openAiWs.on("error", (error) => {
            console.error("Error in the OpenAI WebSocket:", error);
        });
                
    })
})

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port localhost:${PORT}`);
});


